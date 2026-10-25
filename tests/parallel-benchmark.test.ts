import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {mapPool,parseParallelArgs} from '../scripts/liveuibench/parallel.js';
import {lockResources} from '../scripts/liveuibench/resource-lock.js';
import {parseArgs,runBenchmark} from '../scripts/liveuibench/run.js';
import {mockTransport} from '../scripts/liveuibench/mock-runtime.js';

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-parallel-test-'));
test.after(()=>fs.rm(tmp,{recursive:true,force:true}));
test('worker pool overlaps execution, obeys width, preserves selection order',async()=>{
 let active=0,peak=0;const finished:number[]=[];
 const result=await mapPool([70,5,10,20],2,async(delay,i)=>{
  active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,delay));finished.push(i);active--;return i;
 });
 assert.equal(peak,2);assert.notDeepEqual(finished,[0,1,2,3]);assert.deepEqual(result,[0,1,2,3]);
 await assert.rejects(mapPool([],0,async()=>0),/workers/);
});
test('shared world/runtime lock refuses overlapping evaluation and releases partial acquisitions',async()=>{
 const dir=path.join(tmp,'locks');const first=await lockResources(['world:one'],dir);
 await assert.rejects(lockResources(['runtime:a','world:one'],dir),/locked/);
 const runtime=await lockResources(['runtime:a'],dir);await runtime();await first();
 const again=await lockResources(['runtime:a','world:one'],dir);await again();assert.deepEqual(await fs.readdir(dir),[]);
});
test('managed workers reject shared services, invalid widths and unsupported DSH isolation',()=>{
 const valid=['--model','test','--appworld-bin','./appworld','--appworld-root','./world'];
 for(const extra of [['--api-base','http://localhost:9000'],['--workers','0'],['--world-mode','prepared'],['--harness','dsh']])assert.throws(()=>parseParallelArgs([...valid,...extra]));
 assert.equal(parseParallelArgs(valid).workers,2);
});
test('wire boundary excludes fixture contacts, targets and future turns; evaluator judgments do not change scripted score',async()=>{
 const smoke=JSON.parse(await fs.readFile(new URL('../benchmarks/smoke.json',import.meta.url),'utf8'));
 const fixtureNames=await fs.readdir(new URL('../benchmarks/fixtures/',import.meta.url));
 let fixtureId='';
 for(const name of fixtureNames){const fixture=JSON.parse(await fs.readFile(new URL('../benchmarks/fixtures/'+name,import.meta.url),'utf8'));if(fixture.people?.length){fixtureId=name.slice(0,-5);break;}}
 assert.ok(fixtureId);
 const item=smoke.cases[0];item.id=fixtureId;item.context='PRIVATE_CONTEXT_CANARY';item.intentions[0].expectedBehavior='EVALUATOR_ONLY_TARGET_CANARY';
 item.episodes[2].userMessage='FUTURE_TURN_CANARY';
 const source=path.join(tmp,'wire-cases.json');await fs.writeFile(source,JSON.stringify(smoke));
 const runtime=mockTransport();const calls:{route:string,body:any}[]=[];
 const server=http.createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const part of req)chunks.push(part);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
  calls.push({route:req.url!,body});
  const data=req.url==='/evaluator/run'?{status:'failed',reason:'Deliberate independent judge disagreement'}:await runtime.request(req.url!,body);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const o=parseArgs(['--mock','--cases',source,'--out',path.join(tmp,'wire')]);Object.assign(o,{mode:'live',evaluator:'behavior',worldMode:'prepared',agentEvaluator:true,apiBase:`http://127.0.0.1:${(server.address() as any).port}`});
  const report=await runBenchmark(o);
  assert.equal(report.status,'passed');assert.equal(report.comparable,false);
  assert.equal(report.results[0].groups[0].agentEvaluator.status,'failed');
  const generation=calls.find(x=>x.route==='/agent/run')!.body;
  assert.equal(generation.knownPeople,undefined);assert.equal(generation.context,undefined);assert.equal(generation.assertions,undefined);
  assert.ok(!JSON.stringify(generation).includes('CANARY'));
  const actions=calls.filter(x=>x.route==='/agent/action');
  assert.ok(!JSON.stringify(actions[0]).includes('FUTURE_TURN_CANARY'));assert.ok(JSON.stringify(actions[1]).includes('FUTURE_TURN_CANARY'));
  assert.equal(calls.at(-1)!.route,'/evaluator/run');assert.match(JSON.stringify(calls.at(-1)),/EVALUATOR_ONLY_TARGET_CANARY/);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('a successful no-op prepare hook cannot pass managed isolation verification',async()=>{
 const hook=path.join(tmp,'noop-hook');await fs.writeFile(hook,'#!/bin/sh\nexit 0\n',{mode:0o755});
 const o=parseArgs(['--mock','--out',path.join(tmp,'no-receipt')]);Object.assign(o,{mode:'live',worldMode:'isolated',prepareHook:hook,isolationEvidence:{runId:'missing-receipt',runtimePort:19001,worldPort:19002,storage:tmp}});
 const result=await runBenchmark(o);assert.equal(result.status,'failed');assert.equal(result.metrics.assertions,10);assert.equal(result.metrics.passedAssertions,0);assert.match(result.results[0].groups[0].error,/preparation.json/);
});
test('all shared-world scripted groups precede active evaluators and revision diagnostics',async()=>{
 const smoke=JSON.parse(await fs.readFile(new URL('../benchmarks/smoke.json',import.meta.url),'utf8'));
 const item=smoke.cases[0];item.episodeGroups=[{intentionIndex:0,episodes:item.episodes},{intentionIndex:0,episodes:item.episodes}];
 const source=path.join(tmp,'grouped.json');await fs.writeFile(source,JSON.stringify(smoke));
 const runtime=mockTransport();const calls:string[]=[];
 const server=http.createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const part of req)chunks.push(part);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
  calls.push(req.url!);const result=req.url==='/evaluator/run'?{status:'passed'}:await runtime.request(req.url!,body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const o=parseArgs(['--mock','--cases',source,'--out',path.join(tmp,'grouped')]);Object.assign(o,{mode:'live',evaluator:'behavior',worldMode:'prepared',agentEvaluator:true,revisionPrompt:'Make title larger',apiBase:`http://127.0.0.1:${(server.address() as any).port}`});
  const r=await runBenchmark(o);assert.equal(r.results[0].groups.length,2);
  const firstDiagnostic=calls.findIndex(x=>x==='/agent/patch-app'||x==='/evaluator/run');
  assert.equal(calls.slice(0,firstDiagnostic).filter(x=>x==='/agent/run').length,2);
  assert.equal(calls.slice(0,firstDiagnostic).filter(x=>x==='/agent/action').length,4);
  assert.equal(calls.slice(0,firstDiagnostic).filter(x=>x==='/agent/query-state').length,2);
  assert.equal(calls.filter(x=>x==='/evaluator/run').length,2);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
