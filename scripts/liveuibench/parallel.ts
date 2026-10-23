import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs,selectCases,metrics,type Options} from './run.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
export async function mapPool<T,R>(items:T[],width:number,fn:(item:T,index:number)=>Promise<R>):Promise<R[]> {
 if(!Number.isInteger(width)||width<1||width>32)throw Error('workers must be 1..32');
 const results:R[]=new Array(items.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(width,items.length)},async()=>{while(cursor<items.length){const index=cursor++;results[index]=await fn(items[index],index);}}));
 return results;
}
export function parseParallelArgs(argv:string[]){
 const ordinary:string[]=[];const extra:Record<string,string>={};
 for(let i=0;i<argv.length;i++){
  if(['--workers','--appworld-bin','--appworld-root'].includes(argv[i])){
   const key=argv[i];if(extra[key])throw Error('Duplicate '+key);const value=argv[++i];if(!value||value.startsWith('--'))throw Error('Missing '+key);extra[key]=value;
  }else ordinary.push(argv[i]);
 }
 if(ordinary.some(x=>['--prepare-hook','--world-mode','--api-base','--mock'].includes(x)))throw Error('Managed parallel evaluation owns runtime/world preparation; external api-base, prepare-hook, world-mode, and mock are not allowed');
 const options=parseArgs([...ordinary,'--prepare-hook',path.join(root,'scripts/liveuibench/prepare-appworld.mjs')]);
 const workers=Number(extra['--workers']||2);
 if(!Number.isInteger(workers)||workers<1||workers>32)throw Error('workers must be 1..32');
 if(options.harness!=='native')throw Error('Managed parallel evaluation currently supports native; DSH requires its own isolated backend and has no AppWorld assertion adapter');
 if(!extra['--appworld-bin']||!extra['--appworld-root'])throw Error('--appworld-bin and --appworld-root are required');
 if(process.env.LIVEUIBENCH_AUTHORIZATION)throw Error('Managed local workers must not inherit an authenticated gateway account');
 return {options,workers,appworldBin:path.resolve(extra['--appworld-bin']),appworldRoot:path.resolve(extra['--appworld-root'])};
}
const ports=new Set<number>();
async function freePort(){
 for(;;){const port=await new Promise<number>((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const n=(server.address() as net.AddressInfo).port;server.close(e=>e?reject(e):resolve(n));});});
  if(!ports.has(port)){ports.add(port);return port;}}
}
async function writeJson(file:string,value:any){const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n');await fs.rename(tmp,file);}
async function treeIdentity(directory:string){
 const entries:{path:string;sha256:string;bytes:number}[]=[];
 async function visit(current:string){for(const entry of (await fs.readdir(current,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const file=path.join(current,entry.name);if(entry.isDirectory())await visit(file);
  else if(entry.isFile()){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);entries.push({path:path.relative(directory,file),sha256:hash.digest('hex'),bytes:(await fs.stat(file)).size});}
  else throw Error('Simulator/build input tree must contain regular files and directories');
 }}
 await visit(directory);return {sha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex'),files:entries.length,bytes:entries.reduce((n,e)=>n+e.bytes,0),entries};
}
export async function runParallel(config:ReturnType<typeof parseParallelArgs>){
 const {options:o,workers,appworldBin,appworldRoot}=config;
 await fs.access(appworldBin);await fs.access(path.join(root,'liveuiagent/dist-server/server/index.js'));
 const source=await fs.readFile(o.cases,'utf8');const cases=selectCases(JSON.parse(source),o);
 for(const dir of ['base_dbs','api_docs'])await fs.access(path.join(appworldRoot,'data',dir));
 await fs.mkdir(path.dirname(o.out),{recursive:true});await fs.mkdir(o.out);
 const report:any={benchmark:'LiveUIBench',mode:'live',protocol:'managed-isolated-v1',harness:o.harness,model:o.model,workers,plannedCases:cases.length,
  datasetSha256:createHash('sha256').update(source).digest('hex'),startedAt:new Date().toISOString(),status:'running',comparable:!o.fixtureContacts,results:[],
  limitations:['Scripted workflow assertions are simulator proxies. Independent agent and GUI evaluator results are reported separately.',...(o.fixtureContacts?['Assisted fixture-contact injection enabled; not comparable to unassisted runs.']:[])]};
 const inputs={baseDbs:await treeIdentity(path.join(appworldRoot,'data/base_dbs')),apiDocs:await treeIdentity(path.join(appworldRoot,'data/api_docs')),runtimeBuild:await treeIdentity(path.join(root,'liveuiagent/dist-server')),runnerSource:await treeIdentity(path.join(root,'scripts/liveuibench'))};
 await writeJson(path.join(o.out,'input-manifest.json'),inputs);
 report.inputIdentity=Object.fromEntries(Object.entries(inputs).map(([name,value])=>[name,{sha256:value.sha256,files:value.files,bytes:value.bytes}]));
 const active=new Set<ReturnType<typeof spawn>>();let interrupted=false;
 const stop=()=>{interrupted=true;for(const child of active)child.kill('SIGTERM');};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 let checkpoint=Promise.resolve();
 try{
  const results=await mapPool(cases,workers,async(item,index)=>{
   const storage=path.join(o.out,'workers',item.id);await fs.mkdir(storage,{recursive:true});
   const childOut=path.join(o.out,'cases',item.id);const startedAt=new Date().toISOString();
   let result:any;let childOptions:Options|undefined;
   try{
    if(interrupted)throw Error('Evaluation interrupted before case start');
    // Copy only immutable simulator inputs, never the production runtime DB or apps.
    // Each case gets its own physical copy and in-memory AppWorld process.
    const worldRoot=path.join(storage,'world');await fs.mkdir(path.join(worldRoot,'data'),{recursive:true});
    for(const dir of ['base_dbs','api_docs'])await fs.cp(path.join(appworldRoot,'data',dir),path.join(worldRoot,'data',dir),{recursive:true,dereference:true,errorOnExist:true,force:false});
    try{await fs.copyFile(path.join(appworldRoot,'data/version.txt'),path.join(worldRoot,'data/version.txt'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
    for(const [dir,expected] of [['base_dbs',inputs.baseDbs],['api_docs',inputs.apiDocs]] as const){if((await treeIdentity(path.join(worldRoot,'data',dir))).sha256!==expected.sha256)throw Error('Copied simulator input identity changed');}
    if(interrupted)throw Error('Evaluation interrupted during simulator preparation');
    const runtimePort=await freePort(),worldPort=await freePort();
    childOptions={...o,only:item.id,limit:1,out:childOut,apiBase:`http://127.0.0.1:${runtimePort}`,isolationEvidence:{runId:randomUUID(),runtimePort,worldPort,storage}};
    const cfg=path.join(storage,'worker.json');await writeJson(cfg,{options:childOptions,worldRoot,appworldBin});
    const log=await fs.open(path.join(storage,'worker.log'),'wx');
    if(interrupted){await log.close();throw Error('Evaluation interrupted before worker launch');}
    const child=spawn(process.execPath,['--import','tsx',path.join(root,'scripts/liveuibench/parallel-worker.ts'),cfg],{cwd:root,env:process.env,stdio:['ignore',log.fd,log.fd]});active.add(child);
    const completion=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}).finally(()=>active.delete(child));
    await log.close();const exitCode=await completion;
    const childReport=JSON.parse(await fs.readFile(path.join(childOut,'report.json'),'utf8'));
    result={...childReport.results[0],worker:{...childOptions.isolationEvidence,startedAt,finishedAt:new Date().toISOString(),exitCode},report:path.relative(o.out,path.join(childOut,'report.json'))};
    if(exitCode!==0&&result.status==='passed'){result.status='failed';result.error=`Worker exited ${exitCode} after writing its report`;}
    if(!childReport.comparable)report.comparable=false;
   }catch(e:any){
    const groups=item.episodeGroups?.length?item.episodeGroups:[{intentionIndex:0,episodes:item.episodes||[]}];
    result={id:item.id,split:item.split,status:'failed',error:e.message,worker:{...childOptions?.isolationEvidence,startedAt,finishedAt:new Date().toISOString()},groups:groups.map(g=>({...g,passed:false,episodes:g.episodes.map(ep=>({...ep,passed:false,assertions:ep.assertions.map(a=>({...a,passed:false,message:e.message}))}))}))};
   }
   report.results.push({...result,selectionIndex:index});
   checkpoint=checkpoint.then(async()=>{report.results.sort((a:any,b:any)=>a.selectionIndex-b.selectionIndex);report.metrics=metrics(report.results);await writeJson(path.join(o.out,'report.partial.json'),report);});await checkpoint;
   process.stdout.write(`${item.id}: ${result.status}\n`);return result;
  });
  report.results=results;report.metrics=metrics(results);report.status=results.every(r=>r.status==='passed')?'passed':'failed';report.finishedAt=new Date().toISOString();
  await writeJson(path.join(o.out,'report.json'),report);
  await fs.writeFile(path.join(o.out,'report.md'),`# LiveUIBench managed parallel evaluation\n\n${report.metrics.passedCases}/${cases.length} cases passed; ${workers} workers.\n\nModel: ${o.model}. Harness: ${o.harness}. Comparable: ${report.comparable}.\n\nEach case has a separate runtime process, SQLite database, application registry, simulator input copy, AppWorld process, ports and evidence directory.\n`);
  return report;
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);for(const child of active)child.kill('SIGTERM');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv.includes('--help'))console.log('Managed parallel LiveUIBench: --workers N --appworld-bin PATH --appworld-root PATH --model MODEL --split dev|public_test|all --limit N --out NEW_DIR [normal benchmark options]. Each case gets a fresh isolated native runtime and AppWorld. DSH and external shared servers are refused.');
 else try{const report=await runParallel(parseParallelArgs(process.argv.slice(2)));console.log(JSON.stringify({status:report.status,metrics:report.metrics}));if(report.status!=='passed')process.exitCode=1;}catch(e:any){console.error(e.message);process.exitCode=2;}
}
