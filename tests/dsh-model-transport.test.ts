import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {httpTransport} from '../scripts/liveuibench/transport.js';
import {withDshWorkflowLlm} from '../scripts/liveuibench/dsh-model-transport.js';

test('nondefault generation model and explicit provider remain bound to browser actions without entering response artifacts',async()=>{
 const received:any[]=[];const artifacts:any[]=[];let ignoreSelection=false;let omitExecution=false;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):undefined;received.push({route:req.url,body});
  const model=ignoreSelection?'account-default':body?.llm?.model||'account-default';
  const execution={harness:'dsh',model,...(req.url?.endsWith('/action')?{actionRuntime:'host-appworld'}:{})};
  res.writeHead(req.url?.endsWith('/action')?202:200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({id:'host-fixture',status:'done',type:'app_created',...(!omitExecution?{execution}:{}),result:{ok:true,text:'Observed result'}}));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base=httpTransport(`http://127.0.0.1:${(server.address() as any).port}`,'fixture',5000,async record=>{artifacts.push(record)},undefined);
  const selected={model:'selected-nondefault',apiBase:'https://provider.example/v1',apiKey:'fixture-private-key'};
  const transport=withDshWorkflowLlm(base,selected);
  const generated=await transport.request('/agent/run',{prompt:'Build a notebook'});
  const action=await transport.request('/agent/complete/apps/dsh_fixture/action',{prompt:'Save my note',context:{value:'record'}});
  assert.equal(generated.execution.model,'selected-nondefault');assert.equal(action.execution.model,'selected-nondefault');assert.equal(action.execution.actionRuntime,'host-appworld');
  assert.equal(received.length,2);assert.deepEqual(received[0].body.llm,selected);assert.deepEqual(received[1].body.llm,selected);
  assert.equal(JSON.stringify(artifacts).includes('fixture-private-key'),false,'response-only artifacts must never include request credentials');
  ignoreSelection=true;await assert.rejects(transport.request('/agent/complete/apps/dsh_fixture/action',{prompt:'Must not silently use default'}),/expected selected-nondefault, received account-default/);
  await assert.rejects(transport.request('/agent/run',{prompt:'Generation must also be confirmed'}),/expected selected-nondefault, received account-default/);
  ignoreSelection=false;omitExecution=true;await assert.rejects(transport.request('/agent/complete/apps/dsh_fixture/action',{prompt:'No execution proof'}),/received missing/);
  omitExecution=false;const unchanged=withDshWorkflowLlm(base);assert.equal(unchanged,base);
  const defaultResult=await unchanged.request('/agent/complete/apps/dsh_fixture/action',{prompt:'Use account default'});
  assert.equal(defaultResult.execution.model,'account-default');assert.equal(received.at(-1).body.llm,undefined);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('unrelated storage and read requests never receive workflow credentials',async()=>{
 const requests:any[]=[];const base={user:'fixture',async request(route:string,body?:any,method?:string){requests.push({route,body,method});return{ok:true};}};
 const transport=withDshWorkflowLlm(base,{model:'chosen',apiKey:'private-fixture',apiBase:'https://provider.example/v1'});
 await transport.request('/agent/complete/apps/dsh_fixture/store',{note:'saved'},'PUT');await transport.request('/agent/complete/apps/dsh_fixture');
 assert.deepEqual(requests,[{route:'/agent/complete/apps/dsh_fixture/store',body:{note:'saved'},method:'PUT'},{route:'/agent/complete/apps/dsh_fixture',body:undefined,method:undefined}]);
});
