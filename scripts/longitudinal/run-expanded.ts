import {readFile,writeFile} from 'node:fs/promises';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
import {validateExpanded,runAnchored,originalCase} from './anchored.js';
const args=process.argv.slice(2);const get=(key:string,fallback?:string)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1]};
const dataset=JSON.parse(await readFile(resolve(get('--dataset','benchmarks/liveuibench-expanded.json')!),'utf8'));
const source=JSON.parse(await readFile(resolve(get('--source','benchmarks/liveuibench.json')!),'utf8'));const validation=validateExpanded(dataset,source);
if(args.includes('--validate'))console.log(JSON.stringify(validation));else{
 const path=get('--adapter'),out=get('--out');if(!path||!out)throw Error('Explicit --adapter and --out required. No real continuation adapter is installed. Use --validate for data checks.');
 const mod=await import(pathToFileURL(resolve(path)).href);if(typeof mod.createAdapter!=='function')throw Error('Adapter must export createAdapter');
 const selected=dataset.cases.filter((c:any)=>!get('--case')||c.id===get('--case'));if(!selected.length)throw Error('Unknown source case');
 const planned=selected.flatMap((c:any)=>c.longitudinalExtensions.filter((e:any)=>!get('--track')||e.track===get('--track')).map((e:any)=>({original:originalCase(c),extension:e})));
 const results:any[]=planned.map(({extension:e}:any)=>({extensionId:e.id,status:'not-run',passed:false,executedSteps:0,plannedSteps:e.sessions.reduce((n:number,s:any)=>n+s.steps.length,0),plannedAssertions:e.sessions.reduce((n:number,s:any)=>n+s.steps.reduce((v:number,t:any)=>v+t.assertions.length,0),0)}));
 const save=()=>writeFile(resolve(out),JSON.stringify({protocol:'liveuibench.source-expansion.v1',comparable:false,realExecutionAdapterRequired:true,validation,plannedExtensions:planned.length,results},null,2));await save();
 for(let i=0;i<planned.length;i++){
  try{const a=await mod.createAdapter();results[i]=await runAnchored(planned[i].original,planned[i].extension,a);}catch(e){results[i]={...results[i],status:'failed',reason:e instanceof Error?e.message:String(e)};}
  await save();if(results[i].cleanupFailed)break;
 }
}
