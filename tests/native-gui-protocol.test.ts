import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs,observedNativeGuiActions} from '../scripts/liveuibench/run.js';
import {apiWasCalled,dbChanged,checkAssertion} from '../scripts/liveuibench/scorer.js';
test('current-message-only visible GUI protocol is explicit and disables gold-driven online evaluator',()=>{
 const o=parseArgs(['--harness','dsh','--model','selected','--world-mode','prepared','--native-interaction','visible-gui-v1','--gui-max-steps','12']);assert.equal(o.nativeInteraction,'visible-gui-v1');assert.equal(o.guiMaxSteps,12);assert.equal(o.guiMaxClicks,8);assert.equal(o.guiEpisodeMs,900000);assert.equal(o.agentEvaluator,false);
 assert.equal(parseArgs(['--mock']).nativeInteraction,'legacy');
 for(const extra of [['--agent-evaluator'],['--revision-prompt','Rewrite'],['--artifact-replay','x'],['--gui-max-steps','41'],['--gui-max-clicks','41'],['--gui-episode-ms','99999999']])assert.throws(()=>parseArgs(['--harness','dsh','--model','selected','--world-mode','prepared','--native-interaction','visible-gui-v1',...extra]));
 assert.throws(()=>parseArgs(['--mock','--native-interaction','visible-gui-v1']));
});
test('multiple actual GUI actions retain real tool evidence but final UI state only comes from last real response',()=>{
 const one={trace:[{agent:'Orchestrator',input:'actual first'}],toolResults:{'appworld.add_note':{tool:{apiName:'add_note',appName:'simple_note'}}},toolDbChanges:[{appName:'simple_note',delta:1}],runtimeState:{entities:[{name:'Earlier record'}]}};
 const two={trace:[{agent:'Orchestrator',input:'actual second'}],toolResults:{'appworld.read_notes':{tool:{apiName:'read_notes',appName:'simple_note'}}},toolDbChanges:[],runtimeState:{entities:[{name:'Final actual record'}]}};
 const merged=observedNativeGuiActions([one,two]);assert.equal(merged.observedActionCount,2);assert.equal(merged.trace.length,2);assert.equal(apiWasCalled(merged,'add_note'),true);assert.equal(apiWasCalled(merged,'read_notes'),true);assert.equal(dbChanged(merged,'simple_note'),true);assert.deepEqual(merged.runtimeState,two.runtimeState);
 assert.equal(checkAssertion({type:'visible_result_grounded',value:'Earlier record'},{actionResult:merged,caseMessages:[]}).passed,false);assert.equal(checkAssertion({type:'visible_result_grounded',value:'Final actual record'},{actionResult:merged,caseMessages:[]}).passed,true);assert.equal(observedNativeGuiActions([]),undefined);
});

test('planner failure counts expose only bounded safe inference metadata, never provider response settings',async t=>{
 const {createServer}=await import('node:http');const {httpTransport}=await import('../scripts/liveuibench/transport.js');
 const server=createServer((_q,r)=>{r.writeHead(504,{'content-type':'application/json'});r.end(JSON.stringify({error:'deadline exceeded',plannerModelCalls:1,apiKey:'must-not-copy',requestHeaders:{Authorization:'must-not-copy'}}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});
 const transport=httpTransport(`http://127.0.0.1:${(server.address() as any).port}`,'test',1000);
 await assert.rejects(transport.request('/evaluator/interaction-step',{}),(e:any)=>e.plannerModelCalls===1&&!JSON.stringify(e).includes('must-not-copy'));
 await assert.rejects(transport.request('/other',{}),(e:any)=>e.plannerModelCalls===undefined);
});
