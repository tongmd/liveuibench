#!/usr/bin/env node
// Explicitly selected per-case hook. Stops only the PID previously started by this hook.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const [caseId,fixture]=process.argv.slice(2);
const executable=process.env.LIVEUIBENCH_APPWORLD_BIN;
const worldRoot=process.env.LIVEUIBENCH_APPWORLD_ROOT;
const port=Number(process.env.LIVEUIBENCH_APPWORLD_PORT||9101);
if(!caseId||!executable||!worldRoot||!Number.isInteger(port)||port<1024||port>65535)throw new Error('Set LIVEUIBENCH_APPWORLD_BIN, LIVEUIBENCH_APPWORLD_ROOT, and optional LIVEUIBENCH_APPWORLD_PORT (default 9101); hook arguments are caseId fixturePath');
const base=`http://127.0.0.1:${port}`;
if(process.env.APPWORLD_API_BASE?.replace(/\/$/,'')!==base)throw new Error(`APPWORLD_API_BASE must be ${base}; configure the LiveUIAgent server with the same dedicated address`);
const stateDir=path.resolve(process.env.LIVEUIBENCH_WORLD_STATE_DIR||path.join(root,'artifacts',`appworld-${port}`));await fs.mkdir(stateDir,{recursive:true});
const pidFile=path.join(stateDir,'process.json');
let previous;try{previous=JSON.parse(await fs.readFile(pidFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(previous){
 if(previous.port!==port||previous.executable!==path.resolve(executable)||previous.worldRoot!==path.resolve(worldRoot))throw new Error('Managed world configuration changed; inspect process.json before reusing its state directory');
 let command='';try{command=(await promisify(execFile)('ps',['-p',String(previous.pid),'-o','command='])).stdout;}catch{}
 if(command){if(!command.includes('appworld')||!command.includes(`--port ${port}`))throw new Error('Stored PID no longer belongs to this AppWorld instance; refusing to signal it');process.kill(previous.pid,'SIGTERM');}
}
const listening=()=>new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));});
for(let n=0;n<30&&await listening();n++)await new Promise(r=>setTimeout(r,200));
if(await listening())throw new Error(`Port ${port} is still occupied; refusing to stop an unmanaged service`);
const log=await fs.open(path.join(stateDir,`${Date.now()}-${caseId}.log`),'wx');
const child=spawn(path.resolve(executable),['serve','apis','--port',String(port),'--root',path.resolve(worldRoot),'--no-show-usage'],{cwd:path.resolve(worldRoot),detached:true,stdio:['ignore',log.fd,log.fd]});
// A cancelled preparation must not leave a detached world before process.json is written.
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{if(child.pid)child.kill('SIGTERM');process.exit(130);});
await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});child.unref();await log.close();
await fs.writeFile(pidFile,JSON.stringify({pid:child.pid,port,executable:path.resolve(executable),worldRoot:path.resolve(worldRoot),caseId},null,2));
let ready=false;for(let i=0;i<90;i++){try{const r=await fetch(base+'/api_docs/app_descriptions',{signal:AbortSignal.timeout(1500)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
if(!ready)throw new Error(`AppWorld did not become healthy; inspect ${stateDir}`);
let hasFixture=false;try{await fs.access(fixture);hasFixture=true;}catch(e){if(e.code!=='ENOENT')throw e;}
if(hasFixture)await new Promise((resolve,reject)=>{const seed=spawn(process.execPath,['--import','tsx',path.join(root,'scripts/liveuibench/seed-fixtures.ts'),'--file',fixture],{cwd:root,stdio:'inherit',env:process.env});seed.once('error',reject);seed.once('exit',code=>code===0?resolve():reject(new Error(`Fixture seed exited ${code}`)));});
const receipt={prepared:true,caseId,apiBase:base,pid:child.pid,worldRoot:path.resolve(worldRoot),fixtureSeeded:hasFixture,fixtureSha256:hasFixture?createHash('sha256').update(await fs.readFile(fixture)).digest('hex'):null,preparedAt:new Date().toISOString(),policy:'selected-case-initial-state-only'};
if(process.env.LIVEUIBENCH_PREPARATION_RECEIPT)await fs.writeFile(process.env.LIVEUIBENCH_PREPARATION_RECEIPT,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt));
