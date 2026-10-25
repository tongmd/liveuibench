import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateCase,runCase,type Adapter,type Case} from './protocol.js';
export const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function originalCase(c:any){const {extensionIds,longitudinalExtensions,...original}=c;return original;}
export function episodeIds(c:any):string[]{return c.episodeGroups?c.episodeGroups.flatMap((g:any)=>g.episodes.map((e:any)=>e.id)):(c.episodes??[]).map((e:any)=>e.id);}
export function validateExpanded(data:any,source:any){
 if(!Array.isArray(data.cases)||data.cases.length!==source.cases.length)throw Error('Original case coverage changed');
 const ids=new Set(),extensions=new Set();let groups=0,steps=0,assertions=0;
 for(let i=0;i<source.cases.length;i++){
  const c=data.cases[i],original=source.cases[i];if(!isDeepStrictEqual(originalCase(c),original))throw Error('Original case changed: '+original.id);
  if(ids.has(c.id))throw Error('Duplicate case');ids.add(c.id);
  const groupCount=c.intentions.length;groups+=groupCount;
  if(c.longitudinalExtensions?.length!==groupCount*2)throw Error('Every original application group requires both tracks');
  const coverage=new Set();
  for(const e of c.longitudinalExtensions){
   validateCase(e);if(extensions.has(e.id))throw Error('Duplicate extension');extensions.add(e.id);
   const b=e.sourceBootstrap;if(b?.caseId!==c.id||b.caseSha256!==hash(original)||!Number.isInteger(b.sourceGroupIndex)||b.sourceGroupIndex<0||b.sourceGroupIndex>=groupCount||b.intentionSha256!==hash(c.intentions[b.sourceGroupIndex])||b.mode!=='execute-original-case'||b.requireAllEpisodes!==true||b.preserveOwnerAndApp!==true)throw Error('Invalid source binding: '+e.id);
   if(e.source.caseId!==c.id||e.source.split!==c.split)throw Error('Source split changed');
   const key=b.sourceGroupIndex+':'+e.track;if(coverage.has(key))throw Error('Duplicate group/track');coverage.add(key);
   steps+=e.sessions.reduce((n:number,s:any)=>n+s.steps.length,0);assertions+=e.sessions.reduce((n:number,s:any)=>n+s.steps.reduce((v:number,t:any)=>v+t.assertions.length,0),0);
  }
  if(!isDeepStrictEqual(c.extensionIds,c.longitudinalExtensions.map((e:any)=>e.id)))throw Error('Extension index mismatch');
 }
 return {sourceCases:ids.size,sourceApplicationGroups:groups,extensions:extensions.size,extensionSteps:steps,extensionAssertions:assertions,executed:false};
}
// This is an evaluation adapter, not a model-facing interface. Original assertions
// remain evaluator-only. Bootstrap must run the existing business driver in a
// fresh isolated namespace; it may not import generated HTML or reset the world
// between bootstrap and continuation.
export interface AnchoredAdapter extends Adapter{
 bootstrapOriginal(input:{originalCase:unknown;caseSha256:string;namespace:string}):Promise<{status:'completed'|'failed'|'unsupported';owner:string;worldId:string;sourceCaseSha256:string;completedEpisodeIds:string[];groups:{intentionIndex:number;appId:string}[];originalReport:unknown;originalPassed:boolean}>;
 beginSession:Adapter['beginSession'] extends (...a:infer A)=>any?(...a:A)=>Promise<{conversationId:string;appId:string;owner:string;conversationReset:true;worldId:string}>:never;
 closeBootstrap?():Promise<void>;
}
async function executeAnchored(original:any,extension:any,adapter:AnchoredAdapter){
 const denominator={plannedSteps:extension.sessions.reduce((n:number,s:any)=>n+s.steps.length,0),plannedAssertions:extension.sessions.reduce((n:number,s:any)=>n+s.steps.reduce((v:number,t:any)=>v+t.assertions.length,0),0)};
 let baseline:any;
 try{
  if(typeof adapter.bootstrapOriginal!=='function')return {extensionId:extension.id,status:'unsupported',passed:false,...denominator,executedSteps:0,reason:'Original business driver adapter not available'};
  baseline=await adapter.bootstrapOriginal({originalCase:structuredClone(original),caseSha256:hash(original),namespace:randomUUID()});
  if(baseline.status!=='completed'||!baseline.originalPassed)return {extensionId:extension.id,status:baseline.status==='unsupported'?'unsupported':'baseline-failed',passed:false,...denominator,executedSteps:0,baseline};
  if(baseline.sourceCaseSha256!==hash(original)||!baseline.owner||!baseline.worldId||!isDeepStrictEqual(baseline.completedEpisodeIds,episodeIds(original))||!baseline.originalReport)throw Error('Incomplete or mismatched original execution receipt');
  const groups=baseline.groups;if(!Array.isArray(groups)||groups.length!==original.intentions.length||new Set(groups.map((g:any)=>g.intentionIndex)).size!==groups.length||new Set(groups.map((g:any)=>g.appId)).size!==groups.length)throw Error('Invalid original application mapping');
  const group=groups.find((g:any)=>g.intentionIndex===extension.sourceBootstrap.sourceGroupIndex);if(!group?.appId)throw Error('Missing target application');
  const c:Case=structuredClone(extension);c.owner=baseline.owner;for(const s of c.sessions){s.owner=baseline.owner;s.appKey=String(group.intentionIndex);}
  const wrapped:Adapter={mode:adapter.mode,capabilities:adapter.capabilities,async beginSession(ctx,opts){const r=await adapter.beginSession(ctx,opts);if(r.owner!==baseline.owner||r.appId!==group.appId||r.worldId!==baseline.worldId)throw Error('Continuation changed owner/world/app identity');return r;},act:adapter.act.bind(adapter),observe:adapter.observe.bind(adapter),endSession:adapter.endSession?.bind(adapter)};
  const continuation=await runCase(c,wrapped);return {extensionId:extension.id,status:continuation.passed?'passed':'failed',passed:continuation.passed,baseline,continuation,...denominator,executedSteps:continuation.executedSteps,modelEvaluated:false};
 }catch(e){return {extensionId:extension.id,status:'failed',passed:false,...denominator,executedSteps:0,baseline,reason:e instanceof Error?e.message:String(e)};}
}

export async function runAnchored(original:any,extension:any,adapter:AnchoredAdapter){
 const result=await executeAnchored(original,extension,adapter);
 try{await adapter.closeBootstrap?.();}catch(error){return {...result,status:'cleanup-failed',passed:false,cleanupFailed:true,cleanupError:error instanceof Error?error.message:String(error)};}
 return result;
}
