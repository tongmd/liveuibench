import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {NativeAppBrowser} from '../scripts/liveuibench/native-browser.js';
import {appendHostCommand} from '../liveuiagent/server/native-host-command.js';
import {currentHostCommandRoute,GUI_INTERACTION_SYSTEM,validateInteractionInput} from '../liveuiagent/server/gui-interaction-planner.js';
import {planNativeGuiInteractionStep} from '../liveuiagent/server/liveuiagent.js';
import {readNativeGuiSurface} from '../scripts/liveuibench/native-interaction.js';
for(const request of ['Set 06:30 alarms for Monday through Friday with a 10-minute snooze.','Mark the Marlowe thread paid, and send polite follow-up replies in the still-unpaid Rivera Studios and Tenpenny Media threads.'])test('actual product host block DOM extractor carries exact binding: '+request,async t=>{
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'native-command-route-'));t.after(()=>fs.rm(out,{recursive:true,force:true}));
 const data={businessDraft:'',result:''};const initial={protocol:'a2ui',surfaceId:'main',initialData:data,messages:[{createSurface:{surfaceId:'main'}},{updateComponents:{surfaceId:'main',components:[{id:'root',component:'Card',child:'main_column'},{id:'main_column',component:'Column',children:['business_input']},{id:'business_input',component:'TextField',label:'Domain-specific required value',value:{path:'/businessDraft'}}]}},{updateDataModel:{surfaceId:'main',value:structuredClone(data)}}],actionMap:{}};
 const nonce=randomUUID(),host=appendHostCommand(initial,{},nonce);
 const pkg:any={manifest:{appId:'native_fixture',name:'Current commands',permissions:[]},actions:{actions:{}},assets:{icon:{svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'}},ui:{meta:{hostCommand:host.descriptor,a2ui:host.surface,agentWorkflow:[]}}};
 const actions:any[]=[];const planned:any[]=[];const transport:any={async request(route:string,body:any){
  if(route==='/agent/query-state')return{apps:[{appId:'native_fixture',name:'Current commands',status:'ready',version:'1',description:'',preview:{accent:'#4b7560',chips:[],metrics:[],sampleRecords:[],presentation:{glyph:'N',collection:'Records',tagline:'',metric:'0',rows:0,live:true},widget:{kind:'entities',items:[],stats:[],itemLabel:'Records'}},appPackage:pkg,appData:{},runtimeState:{}}],canvasState:{canvasId:'home',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},inputDock:{position:'bottom'}},summary:{text:'',apps:[]}};
  if(route==='/evaluator/interaction-step'){
   assert.equal(body.harness,'native');assert.equal(body.model,'fixture');assert.equal(body.userMessage,request);validateInteractionInput(body);
   const llm:any={model:'fixture',chatCompletion:async(r:any)=>{const actual=JSON.parse(r.messages.find((m:any)=>m.role==='user').content);assert.deepEqual(actual.hostCommandRoute,currentHostCommandRoute(actual));assert(actual.hostCommandRoute);planned.push(actual);return{choices:[{message:{content:JSON.stringify(actions.length?{operation:{},fields:[],action:{kind:'done',reason:'Controlled fixture exchange acknowledged; no further fixture action requested.'}}:{operation:{},fields:[],action:{kind:'command',target:actual.hostCommandRoute.executeTarget,value:request,quote:request}})}}]};}};
   return{step:await planNativeGuiInteractionStep(GUI_INTERACTION_SYSTEM,body,llm),execution:{harness:'native',model:'fixture'},plannerModelCalls:1};
  }
  if(route==='/agent/action'){actions.push(body);return{appPackage:pkg,workflowExecution:{status:'completed',executionId:randomUUID()},summary:'Controlled fixture acknowledgement only'};}
  throw Error('Unexpected fixture route '+route);
 }};
 const browser:any=new NativeAppBrowser(transport,'native_fixture',out,pkg,'native','fixture',undefined,path.resolve('liveuiagent/frontend/snapshot'),30000);t.after(()=>browser.close());await browser.open();
 await browser.page.setViewport({width:390,height:844});
 {
  const view=await readNativeGuiSurface(browser.page),input={userMessage:request,snapshot:view,observations:[]};const route=currentHostCommandRoute(input);assert(route);assert.equal(route.prepare?.enabled,false);
  assert.equal(view.fields.find((f:any)=>f.target===route.fieldTarget).componentId,host.descriptor.inputId);assert.equal(view.buttons.find((b:any)=>b.target===route.executeTarget).componentId,host.descriptor.buttonId);
  validateInteractionInput({appId:'native_fixture',harness:'native',model:'fixture',...input});
  const result=await browser.interact(request,{maxSteps:4,maxClicks:1,deadlineMs:30000});
  assert.equal(result.interactionStatus,'done');assert.equal(result.guiClicks,1);assert.equal(result.attemptedActionRequests,1);assert.equal(result.businessActionCalls,1);assert.equal(result.unresolved,false);assert.deepEqual(result.steps.map((s:any)=>s.step.kind),['fill','click']);assert.equal(planned.length,3);
  assert.equal(planned[0].hostCommandRoute.prepare.enabled,false);assert.equal(planned[0].hostCommandRoute.preparationRequired,false);assert.equal(planned[1].snapshot.fields.find((f:any)=>f.componentId===host.descriptor.inputId).value,request);
  const fresh=await readNativeGuiSurface(browser.page);assert.equal(fresh.fields.find((f:any)=>f.componentId==='business_input').value,'');
  assert.equal(actions.at(-1).harness,'native');assert.equal(actions.at(-1).llm.model,'fixture');assert.equal(actions.at(-1).actionId,'host.app.command');assert.equal(actions.at(-1).eventPayload.requestId,nonce);assert.equal(actions.at(-1).eventPayload.command,request);
 }
 assert.equal(actions.length,1,'one explicit click per fresh controlled request, no planning dispatch or prepare');
});
