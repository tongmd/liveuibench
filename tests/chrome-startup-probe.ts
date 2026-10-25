import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Test-only transparent launcher. Never warm up/retry Chrome or change launch
// arguments, timeout or protocol. Only startup diagnostics go to the artifact.
export async function chromeStartupProbe(executable:string,output:string){
 await fs.mkdir(output,{recursive:true});
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lb-csp-'));
 const wrapper=path.join(directory,'chrome');
 const source=String.raw`const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const executable=EXECUTABLE,output=OUTPUT;const started=Date.now();const file=path.join(output,started+'-'+process.pid+'.json');
const safe=value=>String(value).replace(/(Bearer|Basic)\s+[^\s'";]+/gi,'$1 [redacted]').replace(/(authorization|password|api[_-]?key|access[_-]?token|secret)([=: ]+)[^\s'";]+/gi,'$1$2[redacted]').replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi,'$1[redacted]@');
const allowed=new Set(['user-data-dir','remote-debugging-port','remote-debugging-pipe','headless','ozone-platform','disable-features','enable-features','force-color-profile','password-store','use-mock-keychain','window-size','lang']);
const argv=process.argv.slice(2);const record={startedAt:new Date(started).toISOString(),wrapperPid:process.pid,executable,argv:argv.map(a=>{if(a==='about:blank')return a;if(!a.startsWith('--'))return '[positional argument redacted]';const at=a.indexOf('=');return at<0?a:allowed.has(a.slice(2,at))?safe(a):a.slice(0,at)+'=[redacted]';}),stdoutBytes:0,stderrBytes:0,startupLines:[],devToolsEndpointObserved:false,exitCode:null,signal:null};
const write=()=>{try{fs.writeFileSync(file+'.tmp',JSON.stringify(record,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file);}catch{}};write();
const fragments={stdout:'',stderr:''};function inspect(chunk,stream){let fragment=fragments[stream];if(record.devToolsEndpointObserved)return;fragment=(fragment+chunk.toString('utf8')).slice(-16384);const lines=fragment.split(/\r?\n/);fragment=lines.pop();fragments[stream]=fragment;for(const line of lines){if(/^DevTools listening on ws:\/\//.test(line)){record.devToolsEndpointObserved=true;record.startupLines.push('DevTools listening endpoint observed');}else if(/^\[\d+:\d+:[^\]]+:(?:ERROR|WARNING|FATAL):/.test(line)||/^Received signal \d+/.test(line)||/^#\d+ /.test(line)){record.startupLines.push(safe(line).slice(0,1000));}while(record.startupLines.join('\n').length>8192)record.startupLines.shift();}write();}
const child=cp.spawn(executable,argv,{stdio:['inherit','pipe','pipe']});record.browserPid=child.pid;write();
child.stdout.on('data',chunk=>{record.stdoutBytes+=chunk.length;inspect(chunk,'stdout');process.stdout.write(chunk);});child.stderr.on('data',chunk=>{record.stderrBytes+=chunk.length;inspect(chunk,'stderr');process.stderr.write(chunk);});
child.on('error',e=>{record.spawnError={code:e.code||null,message:safe(e.message)};write();process.exitCode=1;});
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>{record.wrapperReceivedSignal=signal;write();child.kill(signal);});
child.on('exit',(code,signal)=>{record.exitCode=code;record.signal=signal;record.elapsedMs=Date.now()-started;write();});child.on('close',(code,signal)=>{if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal);}else process.exitCode=code===null?1:code;});`;
 await fs.writeFile(wrapper,`#!${process.execPath}\n`+source.replace('EXECUTABLE',JSON.stringify(executable)).replace('OUTPUT',JSON.stringify(output)),{mode:0o700});
 const metadata={executable,realpath:await fs.realpath(executable),nodeVersion:process.version,platform:process.platform,architecture:process.arch,version:null as string|null,versionError:null as string|null};
 await fs.writeFile(path.join(output,'executable.json'),JSON.stringify(metadata,null,2)+'\n');
 return{executable:wrapper,async close(){
  // A hard group kill cannot be caught by the wrapper. Preserve unknown exit
  // status and add a separate observed cleanup state, never guess an exit code.
  for(const name of (await fs.readdir(output)).filter(n=>n!=='executable.json'&&n.endsWith('.json'))){
   const file=path.join(output,name);const value=JSON.parse(await fs.readFile(file,'utf8'));const observations:Record<string,string>={};
   // Observe (do not kill/retry) the library's existing5-second no-CDP cleanup.
   const until=Date.now()+6500;do{for(const key of ['wrapperPid','browserPid']){if(!Number.isSafeInteger(value[key])||value[key]<=0)continue;try{const result=await promisify(execFile)('ps',['-p',String(value[key]),'-o','stat='],{timeout:1000,maxBuffer:1024});observations[key]=result.stdout.trim().startsWith('Z')?'terminated-awaiting-reap':'present:'+result.stdout.trim();}catch(error:any){observations[key]=error.code===1?'absent':'unavailable';}}if(!Object.values(observations).some(s=>s.startsWith('present:'))||Date.now()>=until)break;await new Promise(r=>setTimeout(r,100));}while(true);
   const latest=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...latest,afterCleanupProcessState:observations},null,2)+'\n');
  }
  // Read version only after all actual launches, never as a warm-up.
  try{const result=await promisify(execFile)(executable,['--version'],{timeout:3000,maxBuffer:4096});const version=result.stdout.trim();metadata.version=/^(?:Google Chrome|Chromium|Chrome for Testing|HeadlessChrome) [\w .+()-]+$/.test(version)?version.slice(0,500):'[unrecognized version format]';}catch(error:any){metadata.versionError=String(error.code||error.name||'version unavailable');}
  await fs.writeFile(path.join(output,'executable.json'),JSON.stringify(metadata,null,2)+'\n');await fs.rm(directory,{recursive:true,force:true});
 }};
}
