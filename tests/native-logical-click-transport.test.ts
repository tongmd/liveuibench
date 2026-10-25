import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeAppBrowser} from '../scripts/liveuibench/native-browser.js';

const packageFixture:any={manifest:{appId:'native_dedup',name:'Notes',permissions:[]},actions:{actions:{save:{id:'save'}}},assets:{icon:{svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'}},ui:{meta:{agentWorkflow:[{actionRoutes:[{actionId:'save',componentId:'save'}]}],a2ui:{protocol:'a2ui',surfaceId:'main',initialData:{draft:'visible note'},messages:[{createSurface:{surfaceId:'main'}},{updateComponents:{surfaceId:'main',components:[{id:'root',component:'Column',children:['draft','save']},{id:'draft',component:'TextField',label:'Note',value:{path:'/draft'}},{id:'save',component:'Button',child:'label',action:{event:{name:'actions.save',context:{note:{path:'/draft'}}}}},{id:'label',component:'Text',text:'Save note'}]}},{updateDataModel:{surfaceId:'main',value:{draft:'visible note'}}}]}}}};
async function fixture(mode:string){
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'native-click-dedup-'));let backend=0;let plan=0;
 const transport:any={async request(route:string,body:any){
  if(route==='/agent/query-state')return{apps:[{appId:'native_dedup',name:'Notes',status:'ready',version:'1',description:'Fixture',preview:{accent:'#4b7560',chips:[],metrics:[],sampleRecords:[],presentation:{glyph:'N',collection:'Notes',tagline:'',metric:'0',rows:0,live:true},widget:{kind:'entities',items:[],stats:[],itemLabel:'Records'}},appPackage:packageFixture,appData:{},runtimeState:{}}],canvasState:{canvasId:'home',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},inputDock:{position:'bottom'}},summary:{text:'',apps:[]}};
  if(route==='/evaluator/interaction-step')return{step:plan++%2===0?{kind:'click',target:body.snapshot.buttons[0].target}:{kind:'done',reason:'Observed'},execution:{harness:'native',model:'mock'},plannerModelCalls:1};
  if(route==='/agent/action'){assert.equal(body.eventPayload.identity,0);assert.equal(body.eventPayload.longId,'900719925474099312345678901234567890');backend++;await new Promise(r=>setTimeout(r,80));return mode==='receipt'?{type:'action_receipt',schema:'native-action-receipt-v2',requestId:body.requestId,appId:body.appId,actionId:body.actionId,eventPayloadSha256:'not-a-proof',executionId:'exec-1',state:'completed',replayed:true,redispatched:false,automaticRetry:false}:{type:'action_result',messages:['Saved'],runtimeState:{},workflowExecution:{executionId:'exec-'+backend,status:mode==='unknown'?'outcome_unknown':mode==='partial'?'partial':'completed'},execution:{harness:'native',model:'mock'}};}
  throw Error(route);
 }};
 const browser:any=new NativeAppBrowser(transport,'native_dedup',out,packageFixture,'native','mock',undefined,process.env.NATIVE_TEST_RENDERER_ROOT,30000);
 await browser.open();
 await browser.page.evaluate(`(mode=>{
  const original=window.fetch.bind(window);let click=0;(window).duplicateEvidence=[];
  window.fetch=async(input,init)=>{
   if(!String(input).endsWith('/agent/action'))return original(input,init);
   const body=JSON.parse(init.body);body.eventPayload.identity=0;body.eventPayload.longId='900719925474099312345678901234567890';body.requestId='11111111-1111-4111-8111-'+String(++click).padStart(12,'0');
   const send=(value)=>original(input,{...init,body:JSON.stringify(value)});
   if(mode==='fresh'||mode==='receipt')return send(body);
   const first=send(body);const secondBody=JSON.parse(JSON.stringify(body));secondBody.actionId='actions.'+body.actionId;
   // Canonical JSON equality preserves exact numeric/string identity, independent of key order.
   secondBody.eventPayload=Object.fromEntries(Object.entries(body.eventPayload).reverse());
   if(mode==='mismatch')secondBody.eventPayload.note='different note';if(mode==='mismatch-id')secondBody.requestId='22222222-2222-4222-8222-222222222222';
   const second=mode==='completed'?first.then(()=>send(secondBody)):send(secondBody);
   const [a,b]=await Promise.all([first,second]);(window).duplicateEvidence.push({first:a.status,second:b.status,firstBody:await a.clone().json(),secondBody:await b.json()});return a;
  };
 })(${JSON.stringify(mode)})`);
 return{browser,out,count:()=>backend,async close(){await browser.close();await fs.rm(out,{recursive:true,force:true});}};
}
for(const mode of ['pending','completed'])test(`actual Chrome ${mode} identical HTTP replay shares one logical click and one backend dispatch`,async()=>{
 const f=await fixture(mode);try{const result=await f.browser.interact('Save visible note',{maxSteps:3});assert.equal(result.attemptedActionRequests,2);assert.equal(result.guiClicks,1);assert.equal(result.businessActionCalls,1);assert.equal(f.count(),1);assert.equal(result.actionResults.length,1);const evidence=await f.browser.page.evaluate(()=>(window as any).duplicateEvidence);assert.equal(evidence.length,1);assert.deepEqual([evidence[0].first,evidence[0].second],[200,200]);assert.deepEqual(evidence[0].firstBody,evidence[0].secondBody);assert.equal(result.unresolved,false);}finally{await f.close();}
});
for(const mode of ['unknown','partial','mismatch','mismatch-id','receipt'])test(`actual Chrome ${mode} does not replay or turn an unconfirmed response into success`,async()=>{
 const f=await fixture(mode);try{await assert.rejects(f.browser.interact('Save visible note',{maxSteps:3}),/complete operation|duplicate|unresolved|Unarmed/i);assert.equal(f.count(),1);assert.equal(f.browser.unresolved,true);await assert.rejects(f.browser.interact('Never retry',{maxSteps:3}),/unresolved/);assert.equal(f.count(),1);}finally{await f.close();}
});
test('new visible clicks have fresh UUIDs and never share a prior logical click cache',async()=>{
 const f=await fixture('fresh');try{for(let n=0;n<2;n++){const result=await f.browser.interact('Save visible note again',{maxSteps:3});assert.equal(result.guiClicks,1);assert.equal(result.businessActionCalls,1);assert.equal(result.attemptedActionRequests,1);assert.equal(result.actionResults.length,1);}assert.equal(f.count(),2);}finally{await f.close();}
});
