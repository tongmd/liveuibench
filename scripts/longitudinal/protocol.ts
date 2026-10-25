import { isDeepStrictEqual } from 'node:util';

export type Assertion = { id: string; type: string; scope?: 'owner'|'app'; key?: string; value?: unknown; path?: string[]; fromStep?: string; selector?: string; text?: string; property?: string; count?: number; min?:number; max?:number; minWidth?:number;maxWidth?:number;minHeight?:number;maxHeight?:number };
export type Step = { id: string; kind: 'message'|'reopen'; message?: string; assertions: Assertion[] };
export type Case = { schemaVersion: 'liveuibench.longitudinal.v1'; id: string; track: 'agent-memory'|'personalized-ui'; source: { kind: 'authored'; [key:string]:unknown }; owner: string; sessions: { id:string; owner?:string; appKey?:string; resetConversation:true; steps:Step[] }[] };
export type Context = { caseId:string; owner:string; appKey:string; sessionId:string; stepId?:string };
export type DOMNode = { visible:boolean; text:string; computedStyle:Record<string,string>;bounds?:{width:number;height:number} };
export type Observation = { provenance: { kind:'real'|'fixture'; memory:'scoped-readback'|'unsupported'; state:'persistent-readback'|'unsupported'; dom:'browser-computed'|'unsupported' }; memory: { owner:Record<string,unknown>; app:Record<string,unknown> }; state:unknown; dom:Record<string,DOMNode[]> };
// The adapter receives neither future user messages nor evaluation assertions.
export interface Adapter {
 mode:'real'|'fixture';
 capabilities:{sessionReset:true;reopen:true;scopedMemory:true;persistentState:true;computedDOM:true};
 beginSession(context:Context, options:{resetConversation:true;preserveOwnerState:true}):Promise<{conversationId:string;appId:string;owner:string;conversationReset:true}>;
 act(context:Context, action:{kind:'message';message:string}|{kind:'reopen'}):Promise<{status:'completed'|'unsupported'|'failed';reason?:string;receipt?:{appId:string;owner:string;reopened:true}}>;
 observe(context:Context, request:{memoryKeys:{scope:'owner'|'app';key:string}[]; selectors:{selector:string;properties:string[]}[]}):Promise<Observation>;
 endSession?(context:Context):Promise<void>;
}
const allowed = new Set(['memory-equals','memory-absent','state-equals','state-preserved','dom-visible','dom-absent','dom-style','dom-count','dom-style-number','dom-bounds']);
function requireValue(ok:unknown, message:string):asserts ok { if(!ok) throw new Error(message); }
export function validateCase(input:unknown):asserts input is Case {
 const c=input as Case;
 requireValue(c?.schemaVersion==='liveuibench.longitudinal.v1' && typeof c.id==='string' && c.id.length && ['agent-memory','personalized-ui'].includes(c.track),'Invalid case header');
 requireValue(c.source?.kind==='authored' && typeof c.owner==='string' && c.owner.length && Array.isArray(c.sessions)&&c.sessions.length,'Invalid case source/owner/sessions');
 const sessions=new Set<string>(),steps=new Set<string>(),assertionIds=new Set<string>();
 for(const session of c.sessions){
  requireValue(typeof session.id==='string'&&!sessions.has(session.id)&&session.resetConversation===true&&Array.isArray(session.steps)&&session.steps.length,'Invalid/duplicate session');sessions.add(session.id);
  requireValue(session.appKey===undefined||(typeof session.appKey==='string'&&session.appKey.length),'Invalid app key');
  requireValue(session.owner===undefined||(typeof session.owner==='string'&&session.owner.length),'Invalid session owner');
  for(const s of session.steps){
   requireValue(typeof s.id==='string'&&!steps.has(s.id)&&['message','reopen'].includes(s.kind)&&Array.isArray(s.assertions)&&s.assertions.length,'Invalid/duplicate step');
   requireValue(s.kind==='reopen'||(typeof s.message==='string'&&s.message.length),'Missing current message');
   for(const a of s.assertions){
    requireValue(typeof a.id==='string'&&!assertionIds.has(a.id)&&allowed.has(a.type),'Unknown/duplicate assertion');assertionIds.add(a.id);
    if(a.type.startsWith('memory-'))requireValue(['owner','app'].includes(a.scope!)&&typeof a.key==='string'&&a.key.length,'Invalid memory assertion');
    if(a.type==='memory-equals'||a.type==='state-equals')requireValue(Object.hasOwn(a,'value'),'Missing expected value');
    if(a.type.startsWith('state-'))requireValue(Array.isArray(a.path)&&a.path.every(p=>typeof p==='string'&&!['__proto__','constructor','prototype'].includes(p)),'Invalid state path');
    if(a.type==='state-preserved')requireValue(typeof a.fromStep==='string'&&steps.has(a.fromStep),'Baseline must be an earlier step');
    if(a.type.startsWith('dom-'))requireValue(typeof a.selector==='string'&&a.selector.length,'Missing selector');
    if(a.type==='dom-style')requireValue(typeof a.property==='string'&&typeof a.value==='string','Invalid style assertion');
    if(a.type==='dom-style-number')requireValue(typeof a.property==='string'&&(Number.isFinite(a.min)||Number.isFinite(a.max))&&(a.min===undefined||Number.isFinite(a.min))&&(a.max===undefined||Number.isFinite(a.max))&&(a.min===undefined||a.max===undefined||a.min<=a.max),'Invalid numeric style bounds');
    if(a.type==='dom-bounds'){const values=[a.minWidth,a.maxWidth,a.minHeight,a.maxHeight];requireValue(values.some(Number.isFinite)&&values.every(v=>v===undefined||(Number.isFinite(v)&&v>=0))&&(a.minWidth===undefined||a.maxWidth===undefined||a.minWidth<=a.maxWidth)&&(a.minHeight===undefined||a.maxHeight===undefined||a.minHeight<=a.maxHeight),'Invalid bounds');}
    if(a.type==='dom-count')requireValue(Number.isInteger(a.count)&&a.count!>=0,'Invalid count assertion');
   }
   steps.add(s.id);
  }
 }
}
function pathValue(state:unknown,path:string[]){let value:any=state;for(const part of path){if(value===null||typeof value!=='object'||!Object.hasOwn(value,part))return {exists:false,value:undefined};value=value[part];}return {exists:true,value};}
function check(a:Assertion,o:Observation,history:Map<string,{owner:string;appKey:string;observation:Observation}>,owner:string,appKey:string){
 if(a.type.startsWith('memory-')){
  if(o.provenance.memory!=='scoped-readback')return false;
  const memory=o.memory?.[a.scope!];if(!memory||typeof memory!=='object')return false;
  return a.type==='memory-absent'?!Object.hasOwn(memory,a.key!):Object.hasOwn(memory,a.key!)&&isDeepStrictEqual(memory[a.key!],a.value);
 }
 if(a.type.startsWith('state-')){
  if(o.provenance.state!=='persistent-readback')return false;
  const actual=pathValue(o.state,a.path!);if(!actual.exists)return false;
  if(a.type==='state-equals')return isDeepStrictEqual(actual.value,a.value);
  const before=history.get(a.fromStep!);if(!before||before.owner!==owner||before.appKey!==appKey||before.observation.provenance.state!=='persistent-readback')return false;
  const baseline=pathValue(before.observation.state,a.path!);return baseline.exists&&isDeepStrictEqual(actual.value,baseline.value);
 }
 if(o.provenance.dom!=='browser-computed'||!Object.hasOwn(o.dom??{},a.selector!))return false;
 const nodes=o.dom[a.selector!];if(!Array.isArray(nodes))return false;
 const matches=nodes.filter(n=>n.visible===true&&(a.text===undefined||n.text.includes(a.text)));
 if(a.type==='dom-visible')return matches.length>0;
 if(a.type==='dom-absent')return matches.length===0;
 if(a.type==='dom-count')return nodes.filter(n=>n.visible===true).length===a.count;
 if(a.type==='dom-bounds')return matches.length>0&&matches.every(n=>{const b=n.bounds;return b&&Number.isFinite(b.width)&&Number.isFinite(b.height)&&(a.minWidth===undefined||b.width>=a.minWidth)&&(a.maxWidth===undefined||b.width<=a.maxWidth)&&(a.minHeight===undefined||b.height>=a.minHeight)&&(a.maxHeight===undefined||b.height<=a.maxHeight)});
 if(a.type==='dom-style-number')return matches.length>0&&matches.every(n=>{const raw=n.computedStyle?.[a.property!]??'';const v=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/.test(raw)?parseFloat(raw):NaN;return Number.isFinite(v)&&(a.min===undefined||v>=a.min)&&(a.max===undefined||v<=a.max)});
 return matches.length>0&&matches.every(n=>n.computedStyle?.[a.property!]===a.value);
}
async function executeCase(c:Case,adapter:Adapter,results:any[]){
 validateCase(c);requireValue(['real','fixture'].includes(adapter.mode),'Invalid adapter mode');requireValue(adapter.capabilities&&['sessionReset','reopen','scopedMemory','persistentState','computedDOM'].every(key=>(adapter.capabilities as any)[key]===true),'Adapter capabilities unsupported');const appIds=new Map<string,string>(),conversations=new Set<string>();const execution={kind:adapter.mode,comparable:false,realModelCalls:adapter.mode==='fixture'?0:null};const history=new Map<string,{owner:string;appKey:string;observation:Observation}>();
 for(const session of c.sessions){const context:Context={caseId:c.id,owner:session.owner??c.owner,appKey:session.appKey??'primary',sessionId:session.id};
  const sessionReceipt=await adapter.beginSession(context,{resetConversation:true,preserveOwnerState:true});
  requireValue(sessionReceipt?.owner===context.owner&&sessionReceipt.conversationReset===true&&typeof sessionReceipt.conversationId==='string'&&sessionReceipt.conversationId.length&&!conversations.has(sessionReceipt.conversationId)&&typeof sessionReceipt.appId==='string'&&sessionReceipt.appId.length,'Missing fresh-session receipt');
  const appScope=JSON.stringify([context.owner,context.appKey]);
  requireValue(!appIds.has(appScope)||appIds.get(appScope)===sessionReceipt.appId,'App identity changed across session');
  requireValue(![...appIds.entries()].some(([scope,id])=>scope!==appScope&&id===sessionReceipt.appId),'Cross-owner/app identity collision');
  appIds.set(appScope,sessionReceipt.appId);conversations.add(sessionReceipt.conversationId);
  try {for(const step of session.steps){const current={...context,stepId:step.id};let outcome:any;
   try { const action=await adapter.act(current,step.kind==='message'?{kind:'message',message:step.message!}:{kind:'reopen'});
    if(action.status==='completed'&&step.kind==='reopen')requireValue(action.receipt?.reopened===true&&action.receipt.appId===sessionReceipt.appId&&action.receipt.owner===context.owner,'Missing same-app reopen receipt');
    if(action.status!=='completed'){outcome={stepId:step.id,status:action.status,reason:action.reason,assertions:step.assertions.map(a=>({id:a.id,passed:false}))};}
    else{
     const request={memoryKeys:step.assertions.filter(a=>a.type.startsWith('memory-')).map(a=>({scope:a.scope!,key:a.key!})),selectors:step.assertions.filter(a=>a.type.startsWith('dom-')).map(a=>({selector:a.selector!,properties:a.property?[a.property]:[]}))};
     const observation=await adapter.observe(current,request);
     requireValue(observation?.provenance?.kind===adapter.mode,'Observation execution mode mismatch');
     const assertions=step.assertions.map(a=>({id:a.id,passed:check(a,observation,history,current.owner,current.appKey)}));
     outcome={stepId:step.id,status:assertions.every(a=>a.passed)?'passed':'failed',assertions,observation};history.set(step.id,{owner:current.owner,appKey:current.appKey,observation:structuredClone(observation)});
    }
   }catch(error){outcome={stepId:step.id,status:'failed',reason:error instanceof Error?error.message:'Adapter failure',assertions:step.assertions.map(a=>({id:a.id,passed:false}))};}
   results.push(outcome);
   // Unresolved/unsupported action is terminal: never replay possible side effects.
   if(outcome.status==='unsupported'||(outcome.status==='failed'&&!outcome.observation))return {caseId:c.id,execution,executionMode:adapter.mode,modelEvaluated:false, realExecution:adapter.mode==='real',passed:false,steps:results};
  }}finally{await adapter.endSession?.(context);}
 }
 return {caseId:c.id,execution,executionMode:adapter.mode,modelEvaluated:false, realExecution:adapter.mode==='real',passed:results.every(r=>r.status==='passed'),steps:results};
}

export async function runCase(c:Case,adapter:Adapter){
 validateCase(c);const results:any[]=[];let report:any;let failure:string|undefined;
 try{report=await executeCase(c,adapter,results);}catch(error){failure=error instanceof Error?error.message:'Adapter failure';}
 const byId=new Map(results.map(result=>[result.stepId,result]));
 const steps=c.sessions.flatMap(session=>session.steps.map(step=>byId.get(step.id)??{stepId:step.id,status:'not-run',reason:failure??'Earlier terminal action',assertions:step.assertions.map(a=>({id:a.id,passed:false,status:'not-run'}))}));
 const assertions=steps.flatMap(step=>step.assertions);
 return {...report,caseId:c.id,execution:{kind:adapter.mode,comparable:false,realModelCalls:adapter.mode==='fixture'?0:null},modelEvaluated:false,realExecution:adapter.mode==='real',passed:!failure&&steps.every(step=>step.status==='passed'),failure,plannedSteps:steps.length,executedSteps:results.length,plannedAssertions:assertions.length,passedAssertions:assertions.filter(a=>a.passed).length,steps};
}
