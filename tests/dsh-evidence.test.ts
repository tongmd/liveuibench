import test from 'node:test';
import assert from 'node:assert/strict';
import {dshActionEvidence} from '../scripts/liveuibench/dsh-evidence.js';
import {checkAssertion} from '../scripts/liveuibench/scorer.js';
const appId = 'dsh_test';
const evidence = {schemaVersion:1, appId, trace:[{agent:'orchestrator',status:'done'}], toolResults:{'appworld.simple_note.create_note':{tool:{appName:'simple_note',apiName:'create_note'}}},toolDbChanges:[{appName:'simple_note',delta:1}]};
const check = (type:string,value:unknown,actionResult:any) => checkAssertion({type,value},{actionResult}).passed;
test('completed current-app host bridge actions provide actual audit assertions without replacing DOM grounding',()=>{
 const r=dshActionEvidence([{id:'job-1',status:'done',evidence,result:{text:'invented item'}}],appId,'A real note');
 assert.equal(check('route_enters_orchestrator',true,r),true);
 assert.equal(check('appworld_api_called','simple_note.create_note',r),true);
 assert.equal(check('appworld_db_changed','simple_note',r),true);
 assert.equal(check('appworld_api_called','create_notebook',r),false);
 assert.equal(check('appworld_db_changed','file_system',r),false);
 assert.equal(check('visible_result_grounded','A real note',r),true);
 assert.equal(check('visible_result_grounded','invented item',r),false);
 assert.equal(checkAssertion({type:'route_exists',value:true},{actionResult:r,pkg:{}}).passed,false);
});
test('missing, forged model-result, stale app, failed, unfinished and malformed evidence cannot pass audits',()=>{
 for(const jobs of [undefined,[],[{id:'x',status:'done',result:{evidence}}],[{id:'x',status:'done',evidence:{...evidence,appId:'other'}}],[{id:'x',status:'failed',evidence}],[{id:'x',status:'running',evidence}],[{id:'x',status:'done',evidence:{...evidence,toolResults:[]}}],[{id:'x',status:'done',evidence:{...evidence,schemaVersion:2}}]]) {
  const r=dshActionEvidence(jobs,appId,'AppWorld create_note orchestrator');
  for(const [type,value] of [['route_enters_orchestrator',true],['appworld_api_called','create_note'],['appworld_db_changed','simple_note']] as const)assert.equal(check(type,value,r),false);
 }
});
test('each turn is independent; duplicate completed jobs are not recounted and multi-call tool evidence survives',()=>{
 const job={id:'a',status:'done',evidence};
 const r=dshActionEvidence([job,job,{id:'b',status:'done',evidence:{...evidence,toolResults:{'appworld.file_system.create_file':{tool:{appName:'file_system',apiName:'create_file'}}},toolDbChanges:[]}}],appId,'');
 assert.equal(r.trace.length,2);assert.equal(r.toolDbChanges.length,1);assert.equal(Object.keys(r.toolResults).length,2);
 assert.equal(check('appworld_api_called','file_system.create_file',r),true);
 assert.equal(check('appworld_db_changed','simple_note',dshActionEvidence([],appId,'')),false);
});
test('verified complete visible host text survives separate on-page input echo without changing echo filtering',()=>{
 const message='Send Invoice #3310 to the billing address';
 const text='Invoice #3310 was sent and is tracked as owing.';
 const job={id:'visible',status:'done',evidence,result:{ok:true,text,data:{entities:[{name:'Invoice #3310',detail:'owing'}],stats:[{label:'Sent',value:1}]}}};
 const visible=message+'\n'+text+'\nInvoice #3310\nowing\nSent\n1';
 const r=dshActionEvidence([job],appId,visible,[message]);
 assert.equal(checkAssertion({type:'visible_result_grounded',value:'Invoice #3310'},{actionResult:r,caseMessages:[message]}).passed,true);
 assert.deepEqual(r.runtimeState.intentResult.visibleHostFragments,[text,'Invoice #3310','owing','Sent','1']);
 const spaced=dshActionEvidence([job],appId,visible.replaceAll(' ',' \n '),[message]);
 assert.ok(spaced.runtimeState.intentResult.visibleHostFragments.includes(text));
});
test('trusted visible host fragments reject echo-only hidden rejected stale and malformed results',()=>{
 const message='Send Invoice #3310 to the billing address';
 const text='Invoice #3310 was sent and is tracked as owing.';
 const good={id:'visible',status:'done',evidence,result:{ok:true,text,data:{entities:[{name:'Invoice #3310'}],stats:[]}}};
 const cases=[
  {jobs:[good],visible:message},
  {jobs:[good],visible:message+'\nInvoice #3310'},
  {jobs:[{...good,result:{...good.result,text:message}}],visible:message},
  {jobs:[{...good,result:{...good.result,ok:false}}],visible:message+'\n'+text},
  {jobs:[{...good,evidence:{...evidence,appId:'old-app'}}],visible:message+'\n'+text},
  {jobs:[{...good,status:'running'}],visible:message+'\n'+text},
  {jobs:[{...good,evidence:undefined}],visible:message+'\n'+text},
 ];
 for(const c of cases){const r=dshActionEvidence(c.jobs,appId,c.visible,[message]);
  assert.deepEqual(r.runtimeState.intentResult.visibleHostFragments,[]);
  assert.equal(checkAssertion({type:'visible_result_grounded',value:'Invoice #3310'},{actionResult:r,caseMessages:[message]}).passed,false);
 }
 // Failed execution evidence still remains available to audit tools; no UI success is fabricated.
 assert.ok(dshActionEvidence([{...good,result:{ok:false,text}}],appId,text,[message]).trace.length);
});
