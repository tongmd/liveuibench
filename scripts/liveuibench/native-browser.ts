import {nativeActionFingerprint} from '../../liveuiagent/server/native-action-not-started.js';
import {verifiedNativeActionNotStarted} from './transport.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer-core';
import type {Transport} from './transport.js';
import {nativeChromeExecutable,nativeFetchAcknowledgementBootstrap,waitForNativeFetchAcknowledgement} from './native-browser-support.js';
import {readNativeGuiSurface,applyNativeGuiStep,waitForNativeGuiClickReady,type NativeGuiStep} from './native-interaction.js';
import {executableActionByOrdinal} from './scorer.js';

/** Uses the product's actual Native A2UI web renderer, not an alternate test
 * renderer. The local server supplies shell metadata; only explicit query/action
 * requests cross the trusted transport. Browser never receives credentials. */
export class NativeAppBrowser {
 private knownNotStartedErrors=new WeakSet<object>();private refusedPayloads=new Set<string>();
 private browser:any;private page:any;private server?:http.Server;private errors:string[]=[];private rendererSha='';private actionResult:any;private actionError:any;private unresolved=false;private businessActionCalls=0;private actionInFlight=false;private clickAwaitingConfirmation=false;private guiInteractionActive=false;private guiProtocolEnabled=false;private guiGate?:{actionId:string;used:boolean};private attemptedActionRequests=0;
 constructor(private transport:Transport,private appId:string,private out:string,private pkg:any,private harness:'native'|'dsh',private model:string,private chrome?:string,private rendererRoot=fileURLToPath(new URL('../../liveuiagent/frontend/snapshot/',import.meta.url)),private timeoutMs=900000){}
 async open(){
  const manifest=JSON.parse(await fs.readFile(path.join(this.rendererRoot,'manifest.json'),'utf8'));const resources=manifest.resources||[{file:manifest.file,sha256:manifest.sha256}];const files=new Map<string,Buffer>();
  for(const r of resources){if(!/^[a-zA-Z0-9_.-]+$/.test(r.file))throw Error('Unsafe Native renderer resource');const b=await fs.readFile(path.join(this.rendererRoot,r.file));if(createHash('sha256').update(b).digest('hex')!==r.sha256)throw Error('Native renderer source SHA mismatch');files.set(r.file,b);}
  if(!files.has('index.html'))throw Error('Native renderer missing entry point');this.rendererSha=createHash('sha256').update(files.get('index.html')!).digest('hex');
  this.server=http.createServer(async(req,res)=>{const json=(v:any,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(v));};try{const route=new URL(req.url!,'http://local').pathname.replace(/^\/liveui/,'')||'/';let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};
   if(route==='/agent/query-state')return json(await this.transport.request(route,body));
   if(route==='/agent/action'){try{this.attemptedActionRequests++;if(this.guiProtocolEnabled){const gate=this.guiGate;const actual=String(body.actionId||'').replace(/^actions\./,'');if(!gate||gate.used||body.appId!==this.appId||actual!==gate.actionId){this.unresolved=true;throw Error('Unarmed, duplicate or mismatched Native GUI action request; no action forwarded');}gate.used=true;}if(this.unresolved||this.actionInFlight){this.unresolved=true;throw Error('Duplicate or unresolved Native action; do not retry');}if(body.appId!==this.appId)throw Error('Native renderer action target mismatch');const fingerprint=nativeActionFingerprint({appId:body.appId,actionId:body.actionId,eventPayload:body.eventPayload});if(this.refusedPayloads.has(fingerprint)){const blocked=Error('This exact Native payload already failed before executor entry; automatic replay is blocked. A different later operation may be evaluated.');this.knownNotStartedErrors.add(blocked);throw blocked;}this.businessActionCalls++;this.actionInFlight=true;if(this.guiProtocolEnabled)this.clickAwaitingConfirmation=true;this.actionResult=await this.transport.request(route,{...body,harness:this.harness,llm:{model:this.model}});return json(this.actionResult);}catch(e:any){this.actionError=e;const proof=verifiedNativeActionNotStarted(e,{appId:body.appId,actionId:body.actionId,eventPayload:body.eventPayload});if(!this.unresolved&&(proof||this.knownNotStartedErrors.has(e))){this.knownNotStartedErrors.add(e);if(proof)this.refusedPayloads.add(nativeActionFingerprint({appId:body.appId,actionId:body.actionId,eventPayload:body.eventPayload}));if(this.guiProtocolEnabled)this.clickAwaitingConfirmation=true;}else this.unresolved=true;return json({error:e.message,...(proof?{nativeActionNotStarted:proof}:{})},500);}finally{this.actionInFlight=false;}}
   if(route==='/agent/settings')return json({user:{models:[]},server:{models:[this.model],hasApiKey:true},effective:{model:this.model,models:[this.model],keySource:'server'},warnings:[]});
   if(route==='/agent/runtime-settings')return json({harness:this.harness,choices:[{id:this.harness,label:this.harness,available:true}],model:{id:this.model,delivery:'native'}});
   if(route==='/agent/models')return json({models:[this.model],default:this.model});
   if(route==='/agent/personal')return json({layout:{},materialLayout:{},appearances:{},memories:[],apps:[],enabledShared:[],hidden:[]});
   if(route==='/agent/chat-history')return json({messages:[]});
   if(route==='/agent/chat-append')return json({id:1});
   if(route.startsWith('/agent/'))return json({error:'Unsupported renderer endpoint '+route},400);
   const name=route==='/'?'index.html':route.slice(1);const data=files.get(name);if(!data)return json({error:'Unknown renderer resource'},404);res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});res.end(data);
  }catch(e:any){json({error:e.message},500);}});
  await new Promise<void>(r=>this.server!.listen(0,'127.0.0.1',r));
  try{this.browser=await puppeteer.launch({executablePath:await nativeChromeExecutable(this.chrome),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});this.page=await this.browser.newPage();await this.page.evaluateOnNewDocument(nativeFetchAcknowledgementBootstrap);await this.page.setViewport({width:1440,height:1000});this.page.on('pageerror',(e:any)=>this.errors.push(e.message));await this.page.goto(`http://127.0.0.1:${(this.server.address() as any).port}/liveui/`);await this.page.waitForFunction((id:string)=>[...document.querySelectorAll('[data-app-id]')].some(n=>n.getAttribute('data-app-id')===id),{timeout:15000},this.appId);const appHandle=await this.page.evaluateHandle((id:string)=>[...document.querySelectorAll('[data-app-id]')].find(n=>n.getAttribute('data-app-id')===id),this.appId);await appHandle.asElement().click({clickCount:2});await appHandle.dispose();await this.page.waitForSelector('.a2ui-host',{timeout:15000});}catch(e){if(this.page){await fs.mkdir(this.out,{recursive:true});await fs.writeFile(path.join(this.out,'native-open-failure.json'),JSON.stringify({errors:this.errors,text:await this.page.evaluate(()=>document.body.innerText)}));}await this.close();throw e;}
 }
 async snapshot(name:string){
  const dom=await this.page.$eval('.a2ui-host',(root:Element)=>{return{visibleText:(root as HTMLElement).innerText,inputCount:[...root.querySelectorAll('input,textarea,select')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';}).length,actionCount:[...root.querySelectorAll('[data-a2ui-action-id]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';}).length,iframeCount:root.querySelectorAll('iframe').length};});
  await fs.mkdir(this.out,{recursive:true});await this.page.screenshot({path:path.join(this.out,name+'.png'),fullPage:true});
  if(!dom.visibleText.trim()||dom.iframeCount||this.errors.length)throw Error('Native renderer did not produce an error-free visible component surface: '+this.errors.join('; '));
  return{...dom,evaluator:'actual-native-a2ui-browser',scope:'actual product renderer DOM; action click verified separately',rendererSha256:this.rendererSha,errors:[...this.errors],passed:Boolean(dom.visibleText.trim())&&dom.iframeCount===0&&this.errors.length===0};
 }
 async snapshotInteraction(name:string){const gui=await this.snapshot(name);const surface=await readNativeGuiSurface(this.page);return{...gui,...surface,inputCount:surface.fields.length,actionCount:surface.buttons.length,protocol:'native-visible-gui-v1'};}
 async submit(message:string,ordinal=1){
  if(this.guiProtocolEnabled)throw Error('Visible GUI protocol cannot be bypassed with legacy submit');
  if(this.unresolved)throw Error('Native UI action remains unresolved; further actions are blocked, do not retry.');
  const {actionId}=executableActionByOrdinal(this.pkg,ordinal);
  // A natural-language episode cannot safely fill several structured fields.
  const inputs=await this.page.$$('.a2ui-host input:not([type=hidden]):not([type=checkbox]):not([type=radio]),.a2ui-host textarea');const editable=[];
  for(const h of inputs){if(await h.evaluate((e:HTMLInputElement)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled&&!e.readOnly;}))editable.push(h);}
  if(editable.length!==1)throw Error(`Unsupported Native GUI episode mapping: expected one visible free-text input, found ${editable.length}; no action was sent`);
  if(!await editable[0].evaluate((e:HTMLInputElement)=>!e.type||['text','search','textarea'].includes(e.type)))throw Error('Unsupported Native GUI episode input type; no action was sent');
  const label=await editable[0].evaluate((e:HTMLInputElement)=>e.getAttribute('aria-label')||[...(e.labels||[])].map(n=>n.textContent).join(' ')||e.closest('.a2ui-field')?.textContent||'');
  if(!/^(?:request|instruction|prompt|command|task|what .*(?:do|want)|请求|指令|任务)$/i.test(label.trim()))throw Error('Unsupported Native GUI input semantics: no unambiguous natural-language request field; no action was sent');
  await editable[0].click();await editable[0].evaluate((e:HTMLInputElement)=>e.select());await this.page.keyboard.press('Backspace');await editable[0].type(message);
  const buttons=await this.page.$$('.a2ui-host [data-a2ui-action-id]');let selected:any;
  for(const b of buttons){if(await b.evaluate((e:Element,id:string)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&[id,'actions.'+id].includes(e.getAttribute('data-a2ui-action-id')||'');},actionId)){if(selected)throw Error('Ambiguous Native GUI action binding');selected=b;}}
  if(!selected)throw Error('Native GUI lacks selected ordinal action binding');this.actionResult=undefined;this.actionError=undefined;const turn=await this.page.evaluate(()=>(window as any).__liveuiBenchNativeFetch.begin());const deadline=Date.now()+this.timeoutMs;await selected.click();
 while(this.actionResult===undefined&&!this.actionError){if(Date.now()>deadline){this.unresolved=true;throw Error('Native GUI action response timed out; do not retry.');}await new Promise(r=>setTimeout(r,50));}
  try{await waitForNativeFetchAcknowledgement(this.page,turn,deadline);}catch(e){this.unresolved=true;throw e;}if(this.actionError)throw this.actionError;
  if(this.actionResult.appPackage)this.pkg=this.actionResult.appPackage;return{actionResult:this.actionResult,gui:await this.snapshot('native-action'),interactionScope:'actual native renderer input and bound button click'};
 }
 async interact(message:string,options:{maxSteps:number;maxClicks?:number;deadlineMs?:number}){
  if(this.guiInteractionActive)throw Error('Native GUI episode already active; concurrent actions are blocked');
  if(this.unresolved)throw Error('Native UI action remains unresolved; do not retry');
  if(!Number.isInteger(options.maxSteps)||options.maxSteps<1||options.maxSteps>40)throw Error('Invalid Native GUI step budget');
  const maxClicks=options.maxClicks??8;if(!Number.isInteger(maxClicks)||maxClicks<1||maxClicks>40)throw Error('Invalid Native GUI click budget');if(options.deadlineMs!==undefined&&(!Number.isFinite(options.deadlineMs)||options.deadlineMs<=0))throw Error('Invalid Native GUI episode deadline');
  const deadline=Date.now()+Math.min(this.timeoutMs,options.deadlineMs??this.timeoutMs);
  const planningFailures:any[]=[];let planningRepairs=0;let planningFeedback:any;const observations:any[]=[];const actionResults:any[]=[];let pendingStep:NativeGuiStep|undefined;let pendingSnapshot:any;let pendingTurn:any;let plannerModelCalls=0;let plannerRequests=0;let unknownPlannerInvocations=0;let guiClicks=0;const plannerExecutions:any[]=[];const initialCalls=this.businessActionCalls;const initialAttempts=this.attemptedActionRequests;this.guiInteractionActive=true;this.guiProtocolEnabled=true;
  const bounded=async<T>(promise:Promise<T>):Promise<T>=>{let timer:any;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Native GUI episode deadline exceeded')),Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}};
  try{for(let i=0;i<options.maxSteps;i++){
   if(this.unresolved)throw Error('Native GUI action remains unresolved; do not retry');if(Date.now()>=deadline)throw Error('Native GUI episode deadline exceeded');
   const snapshot=await bounded(readNativeGuiSurface(this.page));
   plannerRequests++;let planned:any;try{planned=await bounded(this.transport.request('/evaluator/interaction-step',{appId:this.appId,harness:this.harness,model:this.model,userMessage:message,snapshot,observations,...(planningFeedback?{planningFeedback}:{}),remainingBudgetMs:Math.max(1,Math.floor(deadline-Date.now())),stepsRemaining:options.maxSteps-i,clicksRemaining:maxClicks-guiClicks}));}catch(error:any){if(error?.plannerModelCalls===0||error?.plannerModelCalls===1)plannerModelCalls+=error.plannerModelCalls;else unknownPlannerInvocations++;
    planningFailures.push({request:plannerRequests,status:error?.status??null,code:error?.code??null,plannerModelCalls:error?.plannerModelCalls??null,planningContractInvalid:error?.planningContractInvalid===true,error:String(error)});
    if(error?.status===400&&error?.code==='invalid_gui_interaction'&&error?.planningContractInvalid===true&&error?.plannerModelCalls===1&&planningRepairs===0&&!this.unresolved&&!this.actionInFlight&&!this.clickAwaitingConfirmation&&i+1<options.maxSteps&&Date.now()<deadline){planningRepairs++;planningFeedback={kind:'invalid_planning_contract',message:typeof error.planningError==='string'?error.planningError.slice(0,500):'The previous pure planning response violated its JSON contract'};continue;}throw error;}
   planningFeedback=undefined;plannerExecutions.push({execution:{harness:planned.execution?.harness??null,model:planned.execution?.model??null},providerRequests:Number.isInteger(planned.providerRequests)&&planned.providerRequests>=0?planned.providerRequests:null});
   if(planned.plannerModelCalls===0||planned.plannerModelCalls===1)plannerModelCalls+=planned.plannerModelCalls;else unknownPlannerInvocations++;
   if(planned.execution?.harness!==this.harness||planned.execution?.model!==this.model||planned.plannerModelCalls!==1)throw Error('Native GUI planner execution mismatch');
   const step:NativeGuiStep=planned.step;
   if(!step||!['fill','select','check','click','done','unsupported'].includes(step.kind))throw Error('Invalid Native GUI planner step');
   if(step.kind==='unsupported')throw Object.assign(Error('Unsupported Native GUI episode: '+(step.reason||'no supported visible operation')),{code:'native_gui_unsupported'});
   if(step.kind==='done')return{protocol:'native-visible-gui-v1',interactionStatus:'done',unresolved:false,rendererSha256:this.rendererSha,budget:{episodeMs:Math.min(this.timeoutMs,options.deadlineMs??this.timeoutMs),maxSteps:options.maxSteps,maxClicks},steps:observations,planningFailures,planningRepairs,guiClicks,plannerExecutions,plannerRequests,plannerModelCalls,plannerModelCallsKnown:plannerModelCalls,unknownPlannerInvocations,plannerCallScope:'logical step inference invocations; provider retry attempts unknown',businessActionCalls:this.businessActionCalls-initialCalls,attemptedActionRequests:this.attemptedActionRequests-initialAttempts,actionResults,lastActionResult:actionResults.at(-1),actionResult:actionResults.at(-1),gui:await bounded(this.snapshotInteraction('native-interaction'))};
   pendingStep=step;pendingSnapshot=snapshot;const before=this.businessActionCalls;this.actionResult=undefined;this.actionError=undefined;
   if(step.kind==='click')await bounded(waitForNativeGuiClickReady(this.page,step,deadline));
   const turn=step.kind==='click'?await this.page.evaluate(()=>(window as any).__liveuiBenchNativeFetch.begin()):undefined;pendingTurn=turn;
   if(step.kind==='click'){if(guiClicks>=maxClicks)throw Error('Native GUI click budget exhausted');guiClicks++;const button=snapshot.buttons.find((b:any)=>b.target===step.target);if(!button||button.disabled)throw Error('Native GUI click target is not a current enabled bound action');this.guiGate={actionId:String(button.actionId).replace(/^actions\./,''),used:false};}else this.guiGate=undefined;
   await bounded(applyNativeGuiStep(this.page,step));if(this.unresolved||this.actionError)throw this.actionError||Error('Unarmed Native GUI action rejected');
   if(step.kind==='click'){
    while(this.actionResult===undefined&&!this.actionError){if(Date.now()>=deadline)throw Error('Native GUI action response timed out; do not retry');await new Promise(r=>setTimeout(r,20));}
    await waitForNativeFetchAcknowledgement(this.page,turn,deadline);
    if(this.unresolved||this.actionError)throw this.actionError||Error('Duplicate Native action detected');
    if(this.businessActionCalls-before!==1)throw Error('Native GUI click did not invoke exactly one action');
    actionResults.push(this.actionResult);if(this.actionResult.appPackage)this.pkg=this.actionResult.appPackage;
   }else if(this.businessActionCalls!==before)throw Error('Native GUI field change unexpectedly invoked an action');
   this.guiGate=undefined;observations.push({step,ok:true,snapshot:await bounded(readNativeGuiSurface(this.page))});if(step.kind==='click')this.clickAwaitingConfirmation=false;pendingStep=undefined;pendingSnapshot=undefined;
  }throw Error('Native GUI step budget exhausted');
  }catch(e){if(e&&typeof e==='object'&&this.knownNotStartedErrors.has(e)&&this.clickAwaitingConfirmation&&!this.unresolved){try{await bounded(waitForNativeFetchAcknowledgement(this.page,pendingTurn,deadline));this.clickAwaitingConfirmation=false;}catch{this.unresolved=true;}}if(pendingStep)observations.push({step:pendingStep,ok:false,error:String(e),snapshot:pendingSnapshot});if(this.actionInFlight||this.clickAwaitingConfirmation)this.unresolved=true;await fs.mkdir(this.out,{recursive:true});const report={protocol:'native-visible-gui-v1',interactionStatus:this.unresolved?'unresolved':(e as any)?.code==='native_gui_unsupported'?'unsupported':'failed',unresolved:this.unresolved,rendererSha256:this.rendererSha,budget:{episodeMs:Math.min(this.timeoutMs,options.deadlineMs??this.timeoutMs),maxSteps:options.maxSteps,maxClicks},steps:observations,planningFailures,planningRepairs,guiClicks,plannerExecutions,plannerRequests,plannerModelCalls,plannerModelCallsKnown:plannerModelCalls,unknownPlannerInvocations,plannerCallScope:'logical step inference invocations; provider retry attempts unknown',businessActionCalls:this.businessActionCalls-initialCalls,attemptedActionRequests:this.attemptedActionRequests-initialAttempts,actionResults,...(e&&typeof e==='object'&&this.knownNotStartedErrors.has(e)?{knownNotStartedFailure:true,responseConsumptionConfirmed:!this.clickAwaitingConfirmation&&!this.unresolved,...((e as any).nativeActionNotStarted?{nativeActionNotStarted:(e as any).nativeActionNotStarted}:{})}:{}),error:String(e)};await fs.writeFile(path.join(this.out,'native-interaction-failure.json'),JSON.stringify(report,null,2));if(e&&typeof e==='object')Object.assign(e,{nativeGuiInteraction:report});throw e;}finally{this.guiGate=undefined;this.guiInteractionActive=false;}
 }
 async close(){
  const browser=this.browser;this.browser=null;
  if(browser){const child=browser.process();let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([browser.close(),new Promise<void>(r=>{timer=setTimeout(()=>{child?.kill('SIGTERM');r();},3000);})]);}finally{clearTimeout(timer);child?.stdin?.destroy();child?.stdout?.destroy();child?.stderr?.destroy();}
  }
  const server=this.server;this.server=undefined;
  if(server){server.closeAllConnections();if(server.listening)await new Promise<void>(r=>server.close(()=>r()));}
 }
}
