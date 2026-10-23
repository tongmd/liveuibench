import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {runBenchmark,stopPreparations,type Options} from './run.js';
import {releaseOwnedResources} from './resource-lock.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const o:Options=config.options;
const evidence=o.isolationEvidence!;
const storage=evidence.storage;
const env={...process.env,DOTENV_CONFIG_PATH:'/dev/null',HOST:'127.0.0.1',PORT:String(evidence.runtimePort),
 DB_PATH:path.join(storage,'runtime.db'),GENERATED_APPS_DIR:path.join(storage,'apps'),
 LIVEUI_EVALUATION_DIR:path.join(storage,'evaluations'),LIVEUIBENCH_RUN_ID:evidence.runId,
 GUIOS_DSH_API_BASE:'',LIVEUI_DEFAULT_HARNESS:'native',GUIOS_APPWORLD_GROUNDING:'on',
 APPWORLD_ENABLED:'true',APPWORLD_API_BASE:`http://127.0.0.1:${evidence.worldPort}`,
 APPWORLD_SNAPSHOT_ROOT:path.join(storage,'snapshots'),GUIOS_FRONTEND_URL:o.apiBase,LIVEUI_FRONTEND_URL:o.apiBase,
 LIVEUIBENCH_WORLD_STATE_DIR:path.join(storage,'world-control'),
 LIVEUIBENCH_APPWORLD_BIN:config.appworldBin,LIVEUIBENCH_APPWORLD_ROOT:config.worldRoot,
 LIVEUIBENCH_APPWORLD_PORT:String(evidence.worldPort)};
Object.assign(process.env,env);
const log=await fs.open(path.join(storage,'runtime.log'),'wx');
const server=spawn(process.execPath,[path.join(root,'dist-server/server/index.js')],{cwd:root,env,stdio:['ignore',log.fd,log.fd]});
let spawnError:Error|undefined;server.once('error',e=>{spawnError=e;});
await log.close();
let cleaning:Promise<void>|undefined;
async function cleanup(){
 if(cleaning)return cleaning;
 cleaning=(async()=>{
  await stopPreparations();
  if(server.exitCode===null&&server.pid){
   server.kill('SIGTERM');
   await Promise.race([new Promise<void>(r=>server.once('exit',()=>r())),new Promise<void>(r=>setTimeout(r,3000))]);
   if(server.exitCode===null)server.kill('SIGKILL');
  }
  const file=path.join(storage,'world-control/process.json');
  try {
   const world=JSON.parse(await fs.readFile(file,'utf8'));
   if(world.port!==evidence.worldPort||world.worldRoot!==config.worldRoot||world.executable!==config.appworldBin)throw Error('World ownership mismatch; refusing cleanup');
   let command='';try{command=(await promisify(execFile)('ps',['-p',String(world.pid),'-o','command='])).stdout;}catch{}
   if(command){
    if(!command.includes('appworld')||!command.includes(`--port ${world.port}`))throw Error('World PID was reused; refusing cleanup');
    process.kill(world.pid,'SIGTERM');
    let alive=true;for(let i=0;i<30;i++){try{process.kill(world.pid,0);}catch{alive=false;break;}await new Promise(r=>setTimeout(r,100));}
    if(alive)process.kill(world.pid,'SIGKILL');
   }
  }catch(e:any){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e;}
  await releaseOwnedResources();
 })();return cleaning;
}
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void cleanup().finally(()=>process.exit(130));});
try {
 let ready=false;
 for(let i=0;i<150;i++){
  if(spawnError)throw spawnError;
  if(server.exitCode!==null)throw Error(`Runtime exited ${server.exitCode}; see runtime.log`);
  try{const response=await fetch(o.apiBase+'/health',{signal:AbortSignal.timeout(1000)});const health=await response.json();
   if(response.ok&&health.benchmarkRunId===evidence.runId){ready=true;break;}
  }catch{}
  await new Promise(r=>setTimeout(r,200));
 }
 if(!ready)throw Error('Isolated runtime failed identity/readiness check');
 const report=await runBenchmark(o);
 if(report.status!=='passed')process.exitCode=1;
}catch(e:any){console.error(e.message);process.exitCode=2;}
finally{await cleanup();}
