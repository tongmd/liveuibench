import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import {patchDeliverySnapshot} from '../scripts/liveuibench/appworld-delivery.js';
import {parseArgs,runBenchmark,selectCases,redact,comparableProtocol} from '../scripts/liveuibench/run.js';
import {mockTransport} from '../scripts/liveuibench/mock-runtime.js';
import {httpTransport} from '../scripts/liveuibench/transport.js';
import {apiWasCalled,checkAssertion} from '../server/liveui-benchmark.js';
import {runGuiEvaluatorAgent} from '../server/gui-evaluator-agent.js';

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-bench-test-'));
test.after(()=>fs.rm(tmp,{recursive:true,force:true}));
const smoke=JSON.parse(await fs.readFile(new URL('../benchmarks/smoke.json',import.meta.url),'utf8'));
function options(name:string){return parseArgs(['--mock','--out',path.join(tmp,name)]);}

test('offline fixture executes open, submit, revise, fresh reopen, GUI, and code revision with durable artifacts',async()=>{
 const o=options('full');o.revisionPrompt='Make titles larger';const report=await runBenchmark(o);
 assert.equal(report.status,'passed');assert.equal(report.mode,'mock');assert.equal(report.comparable,false);
 assert.equal(report.metrics.assertions,10);assert.equal(report.metrics.fullWorkflowRate,1);
 const g=report.results[0].groups[0];assert.deepEqual(g.episodes.map((e:any)=>e.kind),['open','submit','revise','reopen']);assert.equal(g.gui.passed,true);assert.equal(g.productRevision.passed,true);
 assert.match(await fs.readFile(path.join(o.out,'report.md'),'utf8'),/mock/);
 for(const f of ['generation.json','episode-1.json','episode-2.json','episode-3.json','episode-4.json','gui.json','product-revision.json','report.json'])await fs.access(path.join(o.out,smoke.cases[0].id,'group-1',f));
 await assert.rejects(runBenchmark(o),/EEXIST/);assert.equal(JSON.parse(await fs.readFile(path.join(o.out,'report.json'),'utf8')).status,'passed');
});

test('real HTTP transport executes same full workflow and preserves response artifacts',async()=>{
 const runtime=mockTransport();const calls:string[]=[];const server=http.createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;calls.push(req.url!);assert.match(String(req.headers['x-guios-user']),/^bench-/);
  try{const result=await runtime.request(req.url!,body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));}catch(e:any){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const port=(server.address() as any).port;const o=options('http');Object.assign(o,{mode:'live',worldMode:'prepared',apiBase:`http://127.0.0.1:${port}`});const r=await runBenchmark(o);assert.equal(r.status,'passed');assert.equal(r.comparable,false);assert.deepEqual(calls,['/agent/run','/agent/action','/agent/action','/agent/query-state']);assert.ok((await fs.readdir(path.join(o.out,smoke.cases[0].id))).some(f=>f.startsWith('http-')));}finally{await new Promise<void>(r=>server.close(()=>r()));}
});

test('generation failure retains every planned assertion in denominator; no retry masks errors',async()=>{
 let calls=0;const server=http.createServer((_req,res)=>{calls++;res.statusCode=503;res.end(JSON.stringify({error:'upstream deliberately unavailable'}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const o=options('failure');Object.assign(o,{mode:'live',worldMode:'prepared',apiBase:`http://127.0.0.1:${(server.address() as any).port}`});const r=await runBenchmark(o);assert.equal(r.status,'failed');assert.equal(r.metrics.assertions,10);assert.equal(r.metrics.passedAssertions,0);assert.equal(calls,1);assert.match(r.results[0].groups[0].error,/503/);}finally{await new Promise<void>(r=>server.close(()=>r()));}
});

test('configuration and data selection reject invalid or sealed cases',()=>{
 for(const argv of [['--harness','codex'],['--split','sealed_test'],['--limit','0'],['--evaluator','fake'],['--surprise'],['--model'],['--limit','2','--world-mode','prepared','--model','test']])assert.throws(()=>parseArgs(argv));
 assert.throws(()=>parseArgs(['--model','real-model']),/prepare-hook/);
 assert.equal(parseArgs(['--model','real-model','--world-mode','prepared']).agentEvaluator,true);
 assert.equal(parseArgs(['--model','real-model','--world-mode','prepared','--skip-agent-evaluator']).agentEvaluator,false);
 assert.equal(parseArgs(['--model','real-model','--world-mode','prepared','--evaluator','gui']).agentEvaluator,false);
 assert.throws(()=>selectCases({cases:[{...smoke.cases[0],split:'sealed_test'}]},options('unused')),/No eligible/);
 assert.throws(()=>selectCases({cases:[smoke.cases[0],smoke.cases[0]]},options('unused')),/Duplicate/);
 assert.throws(()=>selectCases({cases:[{...smoke.cases[0],id:'../escape'}]},options('unused')),/Unsafe/);
});

test('empty/quarantined cases are skipped, never pass full-workflow denominator',async()=>{
 const source=path.join(tmp,'empty.json');await fs.writeFile(source,JSON.stringify({cases:[{...smoke.cases[0],episodes:[]}]}));const o=options('empty');o.cases=source;const r=await runBenchmark(o);assert.equal(r.status,'failed');assert.equal(r.metrics.skippedCases,1);assert.equal(r.metrics.fullWorkflowRate,0);
});

test('scorer rejects substring APIs, echo-only state, unknown assertions and absent current action',()=>{
 assert.equal(apiWasCalled({toolResults:{'appworld.spotify.unlike_song':{}}},'like_song'),false);
 assert.equal(apiWasCalled({toolResults:{'appworld.spotify.like_song#2':{}}},'spotify.like_song'),true);
 assert.equal(checkAssertion({type:'visible_result_grounded',value:'secret song'},{actionResult:{runtimeState:{sourcePrompt:'secret song',intentResult:{summary:'I am requesting a secret song for the long trip'}}},caseMessages:['I am requesting a secret song for the long trip']}).passed,false);
 assert.equal(checkAssertion({type:'state_persists',value:'echo'},{reopenState:{lastIntentPayload:'echo'}}).passed,false);
 assert.equal(checkAssertion({type:'appworld_db_changed',value:'spotify'},{}).passed,false);
 assert.equal(checkAssertion({type:'unknown_future_assertion',value:true},{}).passed,false);
 assert.deepEqual(redact({apiKey:'secret',nested:{access_token:'secret',value:1}}),{apiKey:'[REDACTED]',nested:{access_token:'[REDACTED]',value:1}});
});

test('GUI evaluator exact app IDs never select another app and existing artifact directories survive',async()=>{
 const runtime=mockTransport();await runtime.request('/agent/run',{});const state=await runtime.request('/agent/query-state',{});const adapter={queryState:async()=>state};
 await assert.rejects(runGuiEvaluatorAgent({appName:'Notebook',appId:'other'},adapter),/exact appId/);
 const out=path.join(tmp,'existing-gui');await fs.mkdir(out);await fs.writeFile(path.join(out,'keep.txt'),'keep');
 await assert.rejects(runGuiEvaluatorAgent({appName:'Notebook',appId:'mock-notebook',outDir:out},adapter),/EEXIST/);assert.equal(await fs.readFile(path.join(out,'keep.txt'),'utf8'),'keep');
 state.apps[0].appPackage.manifest.intent.kind='complete_app';await assert.rejects(runGuiEvaluatorAgent({appName:'Notebook',appId:'mock-notebook'},adapter),/does not support DSH/);
});

test('HTTP job transport supports native bridge jobId and propagates terminal failure',async()=>{
 let fail=false;const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/start'){res.statusCode=202;res.end(JSON.stringify({jobId:'abc',status:'queued'}));}else res.end(JSON.stringify({id:'abc',status:fail?'error':'done',result:{text:'ok'},error:fail?'deliberate':undefined}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const t=httpTransport(`http://127.0.0.1:${(server.address() as any).port}`,'test',5000);assert.equal((await t.request('/start',{})).result.text,'ok');fail=true;await assert.rejects(t.request('/start',{}),/deliberate/);}finally{await new Promise<void>(r=>server.close(()=>r()));}
});

test('DSH actual Chrome workflow uses HTTP AI/store bridge and retains unsupported evidence failures',async(t)=>{
 const chromeCandidates=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'].filter(Boolean) as string[];let chrome:string|undefined;
 for(const c of chromeCandidates){try{await fs.access(c);chrome=c;break;}catch{}}
 if(!chrome){t.skip('Chrome unavailable; DSH browser test is explicitly unexecuted');return;}
 let store:any={};let turns=0;const appId='dsh_00000000-0000-0000-0000-000000000001';const calls:string[]=[];
 const html=`<!doctype html><html><head><style>body{padding:24px;font:16px system-ui}input,button{padding:12px}</style></head><body><h1>Notebook</h1><label for="note">Note</label><input id="note"><button id="save">Save note</button><p id="result"></p><script>const result=document.querySelector('#result');result.textContent=localStorage.getItem('note')||'Ready';document.querySelector('#save').onclick=async()=>{const r=await guios.ai(document.querySelector('#note').value,{});result.textContent=r.text;localStorage.setItem('note',r.text)};</script></body></html>`;
 const server=http.createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;calls.push(req.url!);res.setHeader('Content-Type','application/json');let result:any;
  if(req.url==='/agent/run')result={type:'app_created',appPackage:{manifest:{appId,name:'Notebook',intent:{kind:'complete_app'}}},execution:{harness:'dsh',model:'fixture-dsh'}};
  else if(req.url===`/agent/complete/apps/${appId}/action`){turns++;res.statusCode=202;result={id:'job-'+turns,status:'queued'};}
  else if(req.url?.startsWith('/agent/complete/jobs/'))result={id:'job-'+turns,status:'done',result:{text:turns===1?'Weekend plan':'Weekend plan updated'}};
  else if(req.url===`/agent/complete/apps/${appId}/store`){store=body;result={ok:true};}
  else if(req.url===`/agent/complete/apps/${appId}`)result={app:{id:appId,name:'Notebook'},html,store};
  else{res.statusCode=404;result={error:'unknown mock route'};}res.end(JSON.stringify(result));
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const o=options('dsh-http-browser');Object.assign(o,{mode:'live',harness:'dsh',model:'fixture-dsh',worldMode:'unmanaged',chrome,apiBase:`http://127.0.0.1:${(server.address() as any).port}`});const report=await runBenchmark(o);const g=report.results[0].groups[0];assert.equal(report.comparable,false);assert.equal(report.status,'failed');assert.equal(g.error,undefined);assert.equal(g.episodes.length,4);assert.ok(g.episodes.every((e:any)=>!e.error));assert.equal(g.episodes[3].assertions[0].passed,true);assert.ok(g.episodes.some((e:any)=>e.assertions.some((a:any)=>a.unsupported)));assert.equal(g.gui.passed,true);assert.equal(store.note,'Weekend plan updated');assert.equal(turns,2);assert.ok(calls.filter(c=>c===`/agent/complete/apps/${appId}`).length>=3);await fs.access(path.join(o.out,smoke.cases[0].id,'group-1','reopen.png'));}finally{await new Promise<void>(r=>server.close(()=>r()));}
});


test('authorization is sent on HTTP requests without entering response artifacts or configuration',async()=>{
 assert.equal(comparableProtocol({mode:'live',harness:'native',worldMode:'isolated'},false),true);
 assert.equal(comparableProtocol({mode:'live',harness:'native',worldMode:'isolated'},true),false);
 const secret='Bearer fixture-authorization-only';const records:any[]=[];
 const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,secret);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const transport=httpTransport(`http://127.0.0.1:${(server.address() as any).port}`,'test',5000,async r=>{records.push(r)},secret);assert.equal((await transport.request('/state',{})).ok,true);assert.ok(!JSON.stringify(records).includes(secret));assert.ok(!JSON.stringify(options('auth')).includes(secret));assert.throws(()=>httpTransport('http://127.0.0.1','test',5000,undefined,'Bearer bad\nheader'),/without line breaks/);}finally{await new Promise<void>(r=>server.close(()=>r()));}
});


test('delivery fixture patch touches only requested order items and rolls back invalid requests',()=>{
 const file=path.join(tmp,'delivery-snapshot.db');const db=new Database(file);db.exec("CREATE TABLE order_items(id INTEGER PRIMARY KEY, order_id INTEGER, delivered_at TEXT, expected_delivery_at TEXT); INSERT INTO order_items VALUES(1,10,NULL,'2023-04-09 12:00:00'),(2,10,NULL,'2023-04-10 12:00:00'),(3,20,NULL,'2023-04-11 12:00:00')");db.close();
 const changed=patchDeliverySnapshot(file,[{orderId:10}]);assert.equal(changed[0].items.length,2);
 assert.throws(()=>patchDeliverySnapshot(file,[{orderId:20,deliveredAt:'2023-04-12T12:00:00'},{orderId:999}]),/no order_items/);
 const check=new Database(file,{readonly:true});try{assert.equal((check.prepare('SELECT delivered_at FROM order_items WHERE id=1').get() as any).delivered_at,'2023-04-09 12:00:00');assert.equal((check.prepare('SELECT delivered_at FROM order_items WHERE id=3').get() as any).delivered_at,null);}finally{check.close();}
});
