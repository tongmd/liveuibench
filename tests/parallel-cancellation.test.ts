import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {parseArgs,runBenchmark,stopPreparations} from '../scripts/liveuibench/run.js';
import {lockResources,releaseOwnedResources} from '../scripts/liveuibench/resource-lock.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check:()=>Promise<boolean>,message:string){
 const deadline=Date.now()+6000;
 while(Date.now()<deadline){if(await check())return;await pause(25);}
 assert.fail(message);
}
async function exists(file:string){try{await fs.access(file);return true;}catch{return false;}}
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e:any){if(e.code==='ESRCH')return false;throw e;}}
async function freePort(){
 const server=net.createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;
}
async function canary(){
 const calls:string[]=[];
 const server=http.createServer((req,res)=>{calls.push(req.url!);req.resume();res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"generation must not start after cancellation"}');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {calls,apiBase:`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
async function options(directory:string,hook:string,apiBase:string){
 const cases=path.join(directory,'cases.json');
 await fs.writeFile(cases,JSON.stringify({cases:[{id:'cancellation-fixture',split:'dev',intentions:[{intention:'Cancellation fixture: never generate.'}],episodes:[{id:'open',kind:'open',assertions:[{type:'input_available',value:true}]}]}]}));
 const value=parseArgs(['--mock','--cases',cases,'--out',path.join(directory,'report'),'--evaluator','behavior']);
 return Object.assign(value,{mode:'live' as const,worldMode:'isolated' as const,prepareHook:hook,apiBase,agentEvaluator:false,timeoutMs:1000});
}
function environment(values:Record<string,string|undefined>){
 const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
 for(const [key,value]of Object.entries(values)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 return ()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}};
}

test('cancelling a cooperative exit-zero preparation prevents generation and records failure',{timeout:15000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-cancel-hook-'));
 const endpoint=await canary();const restore=environment({APPWORLD_API_BASE:undefined});
 const marker=path.join(directory,'hook.pid');const hook=path.join(directory,'prepare');let pid:number|undefined;
 await fs.writeFile(hook,`#!${process.execPath}\nconst fs=require('node:fs');\nprocess.on('SIGTERM',()=>process.exit(0));\nfs.writeFileSync(${JSON.stringify(marker)},String(process.pid));\nsetInterval(()=>{},1000);\n`,{mode:0o755});
 try{
  const running=runBenchmark(await options(directory,hook,endpoint.apiBase));
  await waitFor(()=>exists(marker),'preparation hook did not start');pid=Number(await fs.readFile(marker,'utf8'));
  await Promise.all([stopPreparations(),stopPreparations()]);
  const report=await running;
  assert.equal(report.status,'failed','an exit-zero signal handler must not turn cancellation into successful preparation');
  assert.equal(report.metrics.passedAssertions,0);
  assert.match(report.results[0].groups[0].error,/cancel|prepar|stop|abort/i);
  assert.deepEqual(endpoint.calls,[],'no model/runtime request may start after preparation cancellation');
  assert.equal(alive(pid),false,'stopPreparations must await termination');
  await stopPreparations();
 }finally{
  await stopPreparations();if(pid&&alive(pid))process.kill(pid,'SIGKILL');restore();await endpoint.close();await fs.rm(directory,{recursive:true,force:true});
 }
});

test('cancelling actual AppWorld preparation during readiness does not orphan its detached child',{timeout:15000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-cancel-world-'));
 const endpoint=await canary();const port=await freePort();const state=path.join(directory,'world-control');
 const fake=path.join(directory,'fake-appworld');const marker=path.join(directory,'world.pid');let pid:number|undefined;
 // A real executable accepts the AppWorld argv but deliberately never becomes ready.
 await fs.writeFile(fake,`#!${process.execPath}\nconst fs=require('node:fs');\nfs.writeFileSync(${JSON.stringify(marker)},String(process.pid));\nsetInterval(()=>{},1000);\n`,{mode:0o755});
 const restore=environment({LIVEUIBENCH_APPWORLD_BIN:fake,LIVEUIBENCH_APPWORLD_ROOT:directory,LIVEUIBENCH_APPWORLD_PORT:String(port),LIVEUIBENCH_WORLD_STATE_DIR:state,APPWORLD_API_BASE:`http://127.0.0.1:${port}`});
 try{
  const running=runBenchmark(await options(directory,path.join(root,'scripts/liveuibench/prepare-appworld.mjs'),endpoint.apiBase));
  await waitFor(async()=>await exists(marker)&&await exists(path.join(state,'process.json')),'fake AppWorld child was not started and recorded');
  pid=Number(await fs.readFile(marker,'utf8'));assert.equal(alive(pid),true);
  const record=JSON.parse(await fs.readFile(path.join(state,'process.json'),'utf8'));assert.equal(record.pid,pid);assert.equal(record.port,port);
  await stopPreparations();const report=await running;
  await waitFor(async()=>!alive(pid!),'cancelled preparation left its detached AppWorld child alive');
  assert.equal(report.status,'failed');assert.equal(report.metrics.passedAssertions,0);assert.deepEqual(endpoint.calls,[]);
  assert.equal(await exists(path.join(directory,'report','cancellation-fixture','preparation.json')),false,'cancelled readiness cannot issue a preparation receipt');
 }finally{
  await stopPreparations();if(!pid&&await exists(marker))pid=Number(await fs.readFile(marker,'utf8'));
  if(pid&&alive(pid))process.kill(pid,'SIGKILL');restore();await endpoint.close();await fs.rm(directory,{recursive:true,force:true});
 }
});

test('simultaneous worker cleanup and normal release remove owned locks exactly once',{timeout:10000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-cancel-lock-'));
 const foreign=path.join(directory,'foreign-lock');await fs.mkdir(foreign);await fs.writeFile(path.join(foreign,'owner.json'),'foreign-owner-canary');
 try{
  const one=await lockResources(['runtime:cancel-one','world:cancel-one'],directory);
  const two=await lockResources(['runtime:cancel-two','world:cancel-two'],directory);
  await Promise.all([releaseOwnedResources(),one(),one(),two(),releaseOwnedResources()]);
  assert.deepEqual(await fs.readdir(directory),['foreign-lock']);
  assert.equal(await fs.readFile(path.join(foreign,'owner.json'),'utf8'),'foreign-owner-canary');
  const reacquired=await lockResources(['runtime:cancel-one','world:cancel-one','runtime:cancel-two','world:cancel-two'],directory);
  await reacquired();await releaseOwnedResources();await reacquired();
  assert.deepEqual(await fs.readdir(directory),['foreign-lock']);
 }finally{await releaseOwnedResources();await fs.rm(directory,{recursive:true,force:true});}
});
