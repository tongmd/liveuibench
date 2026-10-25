import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {includesAll,checkAssertion,executableActionByOrdinal,payloadForRoute,type BenchCase,type Episode} from './scorer.js';
import {evaluateRenderedGui} from '../../liveuiagent/server/gui-evaluator-agent.js';
import {httpTransport,type Transport} from './transport.js';
import {NativeAppBrowser} from './native-browser.js';
import {actualDelivery} from './actual-delivery.js';
import {CompleteAppBrowser} from './complete-browser.js';
import {mockTransport} from './mock-runtime.js';
import {dshActionEvidence} from './dsh-evidence.js';
import {withDshWorkflowLlm} from './dsh-model-transport.js';
import {reuseArtifact,readReplayConfiguration} from './artifact-replay.js';
import {lockResources} from './resource-lock.js';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export type Options={harness:'native'|'dsh';model:string;cases:string;split:'dev'|'public_test'|'all';limit:number;out:string;evaluator:'behavior'|'gui'|'both';mode:'live'|'mock';apiBase:string;only?:string;prepareHook?:string;worldMode:'isolated'|'prepared'|'unmanaged';chrome?:string;agentEvaluator:boolean;revisionPrompt?:string;timeoutMs:number;fixtureContacts:boolean;artifactReplay?:string;isolationEvidence?:{runId:string;runtimePort:number;worldPort:number;storage:string}};
export function parseArgs(argv:string[]):Options {
 const booleans=new Set(['--mock','--agent-evaluator','--skip-agent-evaluator','--fixture-contacts']);const allowed=new Set(['--harness','--model','--cases','--split','--limit','--out','--evaluator','--api-base','--only','--prepare-hook','--world-mode','--chrome','--revision-prompt','--timeout-ms','--artifact-replay',...booleans]);
 const args:Record<string,string>={};for(let i=0;i<argv.length;i++){const k=argv[i];if(!allowed.has(k))throw new Error(`Unknown argument ${k}`);if(k in args)throw new Error(`Duplicate argument ${k}`);if(booleans.has(k)){args[k]='true';continue;}const v=argv[++i];if(!v||v.startsWith('--'))throw new Error(`Missing value for ${k}`);args[k]=v;}
 const mode=args['--mock']?'mock':'live';
 const options:Options={harness:(args['--harness']||'native') as any,model:args['--model']||(mode==='mock'?'offline-fixture':''),cases:path.resolve(args['--cases']||path.join(ROOT,mode==='mock'?'benchmarks/smoke.json':'benchmarks/liveuibench.json')),split:(args['--split']||'dev') as any,limit:Number(args['--limit']||1),out:path.resolve(args['--out']||path.join(ROOT,'artifacts/liveuibench',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8))),evaluator:(args['--evaluator']||'both') as any,mode,apiBase:args['--api-base']||'http://127.0.0.1:8787',only:args['--only'],prepareHook:args['--prepare-hook']?path.resolve(args['--prepare-hook']):undefined,worldMode:(args['--world-mode']||'isolated') as any,chrome:args['--chrome'],agentEvaluator:!!args['--agent-evaluator'] || (mode==='live' && (args['--evaluator']||'both')!=='gui' && !args['--skip-agent-evaluator']),revisionPrompt:args['--revision-prompt'],fixtureContacts:args['--fixture-contacts']==='true',artifactReplay:args['--artifact-replay']?path.resolve(args['--artifact-replay']):undefined,timeoutMs:Number(args['--timeout-ms']||900000)};
 if(args['--agent-evaluator']&&args['--skip-agent-evaluator'])throw new Error('agent-evaluator and skip-agent-evaluator conflict');
 if(!['native','dsh'].includes(options.harness))throw new Error('harness must be native or dsh');
 if(!options.model.trim())throw new Error('--model is required for live runs');
 if(!['dev','public_test','all'].includes(options.split))throw new Error('split must be dev, public_test, or all (sealed_test is excluded)');
 if(!['behavior','gui','both'].includes(options.evaluator))throw new Error('evaluator must be behavior, gui, or both');
 if(!['isolated','prepared','unmanaged'].includes(options.worldMode))throw new Error('world-mode must be isolated, prepared, or unmanaged');
 if(!Number.isSafeInteger(options.limit)||options.limit<1)throw new Error('limit must be a positive integer');
 if(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<100||options.timeoutMs>3600000)throw new Error('timeout-ms must be 100..3600000');
 if(mode==='live'&&options.worldMode==='isolated'&&!options.prepareHook)throw new Error('Isolated live runs require --prepare-hook; a pre-seeded single case may use --world-mode prepared');
 if(mode==='live'&&options.worldMode==='prepared'&&options.limit!==1)throw new Error('prepared world requires --limit 1; suites require a reset/seed prepare hook');
 if(mode==='mock'&&(options.harness!=='native'||options.agentEvaluator||options.prepareHook))throw new Error('Offline mock supports native fixture workflow only; no live agent evaluator/prepare hook');
 if(options.artifactReplay&&(options.mode!=='live'||options.harness!=='dsh'||options.limit!==1||options.revisionPrompt))throw Error('Artifact replay requires live DSH, limit1, and no model product-revision generation');
 return options;
}
export function selectCases(raw:any,options:Pick<Options,'split'|'limit'|'only'>):BenchCase[]{
 const rows=Array.isArray(raw)?raw:raw?.cases;if(!Array.isArray(rows))throw new Error('cases must be an array or {cases:[]}');
 const selected:BenchCase[]=[];const ids=new Set<string>();
 for(const c of rows){if(!['dev','public_test'].includes(c.split))continue;if(options.split!=='all'&&c.split!==options.split)continue;if(options.only&&c.id!==options.only)continue;
  if(typeof c.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(c.id))throw new Error('Unsafe/missing case ID');if(ids.has(c.id))throw new Error(`Duplicate case ID ${c.id}`);ids.add(c.id);
  if(!Array.isArray(c.intentions)||!c.intentions.every((x:any)=>typeof x?.intention==='string'&&x.intention.trim()))throw new Error(`Invalid intentions for ${c.id}`);
  const groups=Array.isArray(c.episodeGroups)&&c.episodeGroups.length?c.episodeGroups:[{intentionIndex:0,episodes:c.episodes||[]}];
  for(const g of groups){if(!Number.isInteger(g.intentionIndex)||g.intentionIndex<0||g.intentionIndex>=c.intentions.length)throw new Error(`Invalid intentionIndex for ${c.id}`);if(!Array.isArray(g.episodes)||!g.episodes.every((e:any)=>typeof e?.id==='string'&&['open','submit','revise','followup','reopen'].includes(e.kind)&&Array.isArray(e.assertions)))throw new Error(`Invalid episodes for ${c.id}`);}
  selected.push(c);
 }
 if(!selected.length)throw new Error('No eligible dev/public_test cases selected');return selected.slice(0,options.limit);
}
export function redact(value:any):any{if(Array.isArray(value))return value.map(redact);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/^(api_?key|authorization|password|token|access_token|refresh_token|secret)$/i.test(k)?'[REDACTED]':redact(v)]));return value;}
async function json(file:string,value:any){await fs.writeFile(file,JSON.stringify(redact(value),null,2)+'\n');}
const preparations=new Set<ChildProcess>();
const cancelledPreparations=new WeakSet<ChildProcess>();
export async function stopPreparations(){await Promise.all([...preparations].map(async child=>{
 cancelledPreparations.add(child);
 const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));child.kill('SIGTERM');
 const timer=setTimeout(()=>child.kill('SIGKILL'),3000);try{await closed;}finally{clearTimeout(timer);}
}));}
async function prepare(hook:string,item:BenchCase,fixture:string,out:string){
 await new Promise<void>((resolve,reject)=>{
  const child=spawn(hook,[item.id,fixture],{shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,LIVEUIBENCH_CASE_ID:item.id,LIVEUIBENCH_FIXTURE:fixture,LIVEUIBENCH_PREPARATION_RECEIPT:path.join(out,'preparation.json')}});
  preparations.add(child);const logs:string[]=[];
  child.stdout.on('data',x=>logs.push(x.toString()));child.stderr.on('data',x=>logs.push(x.toString()));
  let hardStop:ReturnType<typeof setTimeout>|undefined;
  const timer=setTimeout(()=>{cancelledPreparations.add(child);child.kill('SIGTERM');hardStop=setTimeout(()=>child.kill('SIGKILL'),3000);},180000);
  child.on('error',reject);child.on('close',code=>{clearTimeout(timer);clearTimeout(hardStop);preparations.delete(child);
   fs.writeFile(path.join(out,'prepare.log'),logs.join('')).then(()=>code===0&&!cancelledPreparations.has(child)?resolve():reject(new Error(`prepare hook ${cancelledPreparations.has(child)?'cancelled or timed out':'exited '+code}; see prepare.log`)),reject);
  });
 });
}
function failedEpisodes(episodes:Episode[],error:string){return episodes.map(ep=>({id:ep.id,kind:ep.kind,error,passed:false,assertions:ep.assertions.map(a=>({...a,passed:false,message:error}))}));}
export function metrics(results:any[]){const assertions=results.flatMap(r=>(r.groups||[]).flatMap((g:any)=>(g.episodes||[]).flatMap((e:any)=>e.assertions||[])));const failed=results.filter(r=>r.status==='failed').length;const passed=results.filter(r=>r.status==='passed').length;return {selectedCases:results.length,passedCases:passed,failedCases:failed,skippedCases:results.filter(r=>r.status==='skipped').length,fullWorkflowRate:results.length?passed/results.length:0,executedCasePassRate:passed+failed?passed/(passed+failed):0,assertions:assertions.length,passedAssertions:assertions.filter(a=>a.passed).length,assertionPassRate:assertions.length?assertions.filter(a=>a.passed).length/assertions.length:0};}
async function runCase(item:BenchCase,o:Options,out:string):Promise<any>{
 const started=Date.now();const groups=item.episodeGroups?.length?item.episodeGroups:[{intentionIndex:0,episodes:item.episodes||[]}];
 const reason=item.quarantined?'quarantined':item.episodesPending?'episodesPending':!groups.some(g=>g.episodes.length)?'no episodes':undefined;
 if(reason){const skipped={id:item.id,split:item.split,status:'skipped',reason,groups:[]};await fs.mkdir(out);await json(path.join(out,'report.json'),skipped);return skipped;}
 await fs.mkdir(out);const fixture=path.join(ROOT,'benchmarks/fixtures',item.id+'.json');let fixtureData:any={};try{fixtureData=JSON.parse(await fs.readFile(fixture,'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;if(item.fixturesRef)throw new Error(`Required fixture missing: ${item.id}`);}
 const groupResults:any[]=[];const diagnostics:Array<()=>Promise<void>>=[];
 try{
  if(o.prepareHook)await prepare(o.prepareHook,item,fixture,out);
  if(o.isolationEvidence){
   const receipt=JSON.parse(await fs.readFile(path.join(out,'preparation.json'),'utf8'));
   let expectedHash:string|null=null;try{expectedHash=createHash('sha256').update(await fs.readFile(fixture)).digest('hex');}catch(e:any){if(e.code!=='ENOENT')throw e;}
   if(receipt.prepared!==true||receipt.caseId!==item.id||receipt.apiBase!==`http://127.0.0.1:${o.isolationEvidence.worldPort}`||receipt.fixtureSha256!==expectedHash||receipt.fixtureSeeded!==Boolean(expectedHash)||!Number.isInteger(receipt.pid))throw Error('Managed world preparation receipt does not match this case, port and fixture');
  }
  let seq=0;const baseTransport=o.mode==='mock'?mockTransport():httpTransport(o.apiBase,'bench-'+randomUUID(),o.timeoutMs,record=>json(path.join(out,`http-${String(++seq).padStart(4,'0')}.json`),record));
  const transport=o.mode==='live'&&o.harness==='dsh'?withDshWorkflowLlm(baseTransport,{model:o.model}):baseTransport;
  for(let gi=0;gi<groups.length;gi++){
   const group=groups[gi];const groupDir=path.join(out,`group-${gi+1}`);await fs.mkdir(groupDir);const intention=item.intentions[group.intentionIndex];const episodes:any[]=[];const record:any={intentionIndex:group.intentionIndex,episodes};groupResults.push(record);let browser:CompleteAppBrowser|undefined;let nativeBrowser:NativeAppBrowser|undefined;
   try{
    const knownPeople=(o.fixtureContacts?(fixtureData.people||[]):[]).map((p:any)=>({name:[p.firstName,p.lastName].filter(Boolean).join(' '),email:p.email,phone:p.phone}));
    const generationInput={prompt:intention.intention,platform:'web',harness:o.harness,llm:{model:o.model},...(knownPeople.length?{knownPeople}:{})};await json(path.join(groupDir,'generation-input.json'),generationInput);
    const generated=o.artifactReplay?await reuseArtifact(transport,o.artifactReplay,item.id,gi,group.intentionIndex,intention.intention):await transport.request('/agent/run',generationInput);await json(path.join(groupDir,'generation.json'),generated);
    if(generated.type!==(o.artifactReplay?'artifact_reused':'app_created')||!generated.appPackage?.manifest?.appId)throw new Error('Generation did not return an app_created package');
    if(o.mode==='live'&&(generated.execution?.harness!==o.harness||generated.execution?.model!==o.model))throw new Error(`Requested runtime was not confirmed: expected ${o.harness}/${o.model}, received ${JSON.stringify(generated.execution||null)}`);
    let pkg=generated.appPackage;const appId=pkg.manifest.appId;record.appId=appId;record.execution=generated.execution||null;
    const delivery=o.mode==='mock'?'mock':actualDelivery(generated,Boolean(o.artifactReplay));record.actualDelivery=delivery;
    if(delivery==='native')record.interactionScope=o.evaluator==='behavior'?'native-direct-api-behavior-only; GUI not assessed':'actual-native-renderer-input-and-click';
    if(delivery==='native'&&o.evaluator!=='behavior'){nativeBrowser=new NativeAppBrowser(transport,appId,groupDir,pkg,o.harness,o.model,o.chrome,undefined,o.timeoutMs);await nativeBrowser.open();}
    if(delivery==='html'){browser=new CompleteAppBrowser(transport,appId,groupDir,o.chrome);await browser.open();}
    for(let ei=0;ei<group.episodes.length;ei++){
     const ep=group.episodes[ei];let response:any;let ctx:any={pkg,caseMessages:[intention.intention,...group.episodes.slice(0,ei+1).map(e=>e.userMessage||'')]};let error:string|undefined;let gui:any;
     try{
      if(ep.kind==='open'){if(browser)gui=await browser.snapshot('open');else if(nativeBrowser)gui=await nativeBrowser.snapshot('open');}
      else if(ep.kind==='reopen'){
       if(nativeBrowser){await nativeBrowser.close();await nativeBrowser.open();gui=await nativeBrowser.snapshot('reopen');response=await transport.request('/agent/query-state',{});const app=(response.apps||[]).find((a:any)=>a.appId===appId);if(!app)throw Error('Native app missing after reopen');ctx.reopenState=app.runtimeState;ctx.reopenData=app.appData;pkg=app.appPackage||pkg;ctx.pkg=pkg;}
       else if(browser){await browser.close();await browser.open();gui=await browser.snapshot('reopen');response=await transport.request('/agent/complete/apps/'+encodeURIComponent(appId));ctx.reopenState=response.store;ctx.reopenData=response.store;}
       else{response=await transport.request('/agent/query-state',{});const app=(response.apps||[]).find((a:any)=>a.appId===appId);if(!app)throw new Error('App missing after fresh reopen query');ctx.reopenState=app.runtimeState;ctx.reopenData=app.appData;pkg=app.appPackage||pkg;ctx.pkg=pkg;}
      }else if(nativeBrowser){response=await nativeBrowser.submit(ep.userMessage||intention.intention,ep.actionOrdinal||1);gui=response.gui;ctx.actionResult=response.actionResult;pkg=response.actionResult.appPackage||pkg;ctx.pkg=pkg;}
      else if(browser){response=await browser.submit(ep.userMessage||intention.intention,ep.actionOrdinal||1);gui=response.gui;ctx.actionResult=dshActionEvidence(response.bridgeResults,appId,gui.visibleText,ctx.caseMessages);}
      else{const {actionId,route}=executableActionByOrdinal(pkg,ep.actionOrdinal||1);response=await transport.request('/agent/action',{appId,actionId,eventPayload:payloadForRoute(route,ep.userMessage||intention.intention),platform:'web',harness:o.harness,llm:{model:o.model}});ctx.actionResult=response;pkg=response.appPackage||pkg;ctx.pkg=pkg;}
     }catch(e:any){error=e.message;}
     const assertions=ep.assertions.map(a=>{
      if(error)return {...a,passed:false,message:error};
      if((browser||nativeBrowser)&&a.type==='input_available')return {...a,passed:gui?.inputCount>0,message:nativeBrowser?'Measured actual Native renderer DOM':'Measured visible complete-app DOM'};
      if((browser||nativeBrowser)&&a.type==='action_available')return {...a,passed:gui?.actionCount>0,message:nativeBrowser?'Measured actual Native renderer DOM':'Measured visible complete-app DOM'};
      const checked=checkAssertion(a,ctx);
      if(nativeBrowser&&checked.passed&&['visible_result_grounded','state_persists'].includes(a.type)&&!includesAll(gui?.visibleText,a.value))return {...a,passed:false,message:'Backend evidence exists but the actual Native component surface does not visibly show this value'};
      const missingDshEvidence=browser&&!checked.passed&&['route_enters_orchestrator','appworld_api_called','appworld_db_changed','route_exists'].includes(a.type)&&!ctx.actionResult?.trace?.length&&!Object.keys(ctx.actionResult?.toolResults||{}).length&&!ctx.actionResult?.toolDbChanges?.length;
      return {...a,...checked,...(missingDshEvidence?{unsupported:true}:{})};
     });const result={id:ep.id,kind:ep.kind,error,passed:!error&&assertions.length>0&&assertions.every(a=>a.passed),assertions,response,gui};episodes.push(result);await json(path.join(groupDir,`episode-${ei+1}.json`),result);
    }
    if(o.evaluator!=='behavior'){
     try{record.gui=nativeBrowser?await nativeBrowser.snapshot('gui-final'):browser?await browser.snapshot('gui-final'):evaluateRenderedGui({appPackage:pkg,appId});}catch(e:any){record.gui={passed:false,error:e.message};}await json(path.join(groupDir,'gui.json'),record.gui);
    }
    diagnostics.push(async()=>{
     try{if(o.revisionPrompt){const revised=await transport.request('/agent/patch-app',{appId,prompt:o.revisionPrompt,harness:o.harness,llm:{model:o.model}});const reopened=await transport.request('/agent/query-state',{});record.productRevision={passed:(reopened.apps||[]).some((a:any)=>a.appId===appId),response:revised};await json(path.join(groupDir,'product-revision.json'),record.productRevision);}}catch(e:any){record.productRevision={passed:false,error:e.message};await json(path.join(groupDir,'product-revision.json'),record.productRevision);}
     if(o.agentEvaluator){try{record.agentEvaluator=await transport.request('/evaluator/run',{appId,appName:pkg.manifest.name,expectedBehaviorPrompt:intention.expectedBehavior||intention.intention,horizonTurns:intention.horizonTurns,channel:'behavior',llm:{model:o.model}});}catch(e:any){record.agentEvaluator={status:'error',error:e.message};}await json(path.join(groupDir,'agent-evaluator.json'),record.agentEvaluator);}
     await json(path.join(groupDir,'report.json'),record);
    });
    // Scripted simulator assertions define workflow success. GUI heuristics and LLM judgments are separate diagnostics.
    record.passed=episodes.length>0&&episodes.every(e=>e.passed);
   }catch(e:any){record.error=e.message;record.passed=false;const remaining=group.episodes.slice(episodes.length);episodes.push(...failedEpisodes(remaining,e.message));}
   finally{await nativeBrowser?.close();await browser?.close();await json(path.join(groupDir,'report.json'),record);}
  }
  // All shared-world scripted groups finish before any diagnostic can mutate state.
  for(const diagnostic of diagnostics)await diagnostic();
 }catch(e:any){for(const g of groups.slice(groupResults.length))groupResults.push({intentionIndex:g.intentionIndex,passed:false,error:e.message,episodes:failedEpisodes(g.episodes,e.message)});}
 const result={id:item.id,split:item.split,status:groupResults.length&&groupResults.every(g=>g.passed)?'passed':'failed',elapsedMs:Date.now()-started,groups:groupResults};await json(path.join(out,'report.json'),result);return result;
}
export function comparableProtocol(o:Pick<Options,'mode'|'harness'|'worldMode'>, authenticatedGateway=Boolean(process.env.LIVEUIBENCH_AUTHORIZATION)){return o.mode==='live'&&o.harness==='native'&&o.worldMode==='isolated'&&!authenticatedGateway;}
export async function runBenchmark(o:Options){
 const release=o.mode==='live'?await lockResources(['runtime:'+new URL(o.apiBase).href.replace(/\/$/,''),...(process.env.APPWORLD_API_BASE?['world:'+new URL(process.env.APPWORLD_API_BASE).href.replace(/\/$/,'')]:[])]):async()=>{};
 try{return await runLockedBenchmark(o);}finally{await release();}
}
async function runLockedBenchmark(o:Options){
 const source=await fs.readFile(o.cases,'utf8');const cases=selectCases(JSON.parse(source),o);
 let replayMetadata:any={};
 if(o.artifactReplay){const replay=await readReplayConfiguration(o.artifactReplay);const manifest=JSON.parse(await fs.readFile(path.join(replay.manifestRoot,'manifest.json'),'utf8'));replayMetadata={artifactReplay:true,artifactReplayManifestSha256:replay.manifestSha256,originalGenerationSourceSha256:manifest.generationSourceSha256,modelGenerationCalls:0};}
 await fs.mkdir(path.dirname(o.out),{recursive:true});await fs.mkdir(o.out); // EEXIST preserves every previous run.
 const report:any={benchmark:'LiveUIBench',mode:o.mode,comparable:comparableProtocol(o)&&Boolean(o.isolationEvidence)&&!o.fixtureContacts,configuration:{...o,...replayMetadata},datasetSha256:createHash('sha256').update(source).digest('hex'),plannedCases:cases.length,startedAt:new Date().toISOString(),status:'running',limitations:o.harness==='dsh'?['DSH audit assertions require completed host bridge evidence bound to the current application; absent evidence fails. Route assertions still require executable workflow metadata. Browser DOM/store checks and unverified isolation remain diagnostic.']:[],results:[]};
 if(o.artifactReplay){report.comparable=false;report.limitations.push('Artifact replay: SHA-locked previously generated HTML is reused; no fresh app generation. This is a separate workflow diagnostic, not a fresh-generation benchmark.');}
 if(o.fixtureContacts)report.limitations.push('Assisted diagnostic: fixture contacts were exposed to generation before their workflow turn. Exclude from unassisted benchmark comparisons.');
 if(o.mode==='live'&&!o.isolationEvidence)report.limitations.push('Fresh runtime/database/world isolation was not verified by the managed parallel launcher; this run is diagnostic.');
 if(process.env.LIVEUIBENCH_AUTHORIZATION)report.limitations.push('Authenticated gateway account isolation is not verified; persistent personal memory may cross cases.');
 async function checkpoint(){report.metrics=metrics(report.results);await json(path.join(o.out,'report.partial.json'),report);}
 await checkpoint();for(const item of cases){process.stdout.write(`[${o.mode}] ${item.id}\n`);try{report.results.push(await runCase(item,o,path.join(o.out,item.id)));}catch(e:any){const groups=item.episodeGroups?.length?item.episodeGroups:[{intentionIndex:0,episodes:item.episodes||[]}];const failure={id:item.id,status:'failed',error:e.message,groups:groups.map(g=>({...g,episodes:failedEpisodes(g.episodes,e.message)}))};report.results.push(failure);await fs.mkdir(path.join(o.out,item.id),{recursive:true});await json(path.join(o.out,item.id,'report.json'),failure);}await checkpoint();}
 report.status=report.results.every((r:any)=>r.status==='passed')?'passed':'failed';report.finishedAt=new Date().toISOString();await json(path.join(o.out,'report.json'),report);
 const m=report.metrics;await fs.writeFile(path.join(o.out,'report.md'),`# LiveUIBench — ${o.mode}\n\nHarness: ${o.harness}; model: ${o.model}. Comparable benchmark run: ${report.comparable}.\n\n${m.passedCases}/${m.selectedCases} selected cases passed; ${m.failedCases} failed; ${m.skippedCases} skipped.\n\nStrict full-workflow rate: ${m.fullWorkflowRate}. Assertions: ${m.passedAssertions}/${m.assertions}.\n\n${report.limitations.join('\n')}\n`);return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv.includes('--help')){console.log('LiveUIBench: --harness native|dsh --model MODEL --cases FILE --split dev|public_test|all --limit N --out NEW_DIR --evaluator behavior|gui|both\nLive isolation: --prepare-hook EXECUTABLE or --world-mode prepared (one case) / unmanaged (diagnostic).\nArtifact replay diagnostic: --artifact-replay MANAGEMENT_CONFIG (SHA-locked prior apps; no fresh generation).\nOptional: --only ID --api-base URL --chrome PATH --skip-agent-evaluator --revision-prompt TEXT --timeout-ms N --fixture-contacts (assisted diagnostic only)\nBehavior/both modes include the independent online evaluator after scripted scoring; --skip-agent-evaluator disables extra model/action calls.\nOffline contract test: --mock (dedicated smoke fixture, never a real benchmark result).');}
 else{try{const report=await runBenchmark(parseArgs(process.argv.slice(2)));console.log(JSON.stringify({status:report.status,mode:report.mode,metrics:report.metrics,out:report.configuration.out}));if(report.status!=='passed')process.exitCode=1;}catch(e:any){console.error(e.message);process.exitCode=2;}}
}
