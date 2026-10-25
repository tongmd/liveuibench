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
