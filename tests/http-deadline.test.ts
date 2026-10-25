import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type RequestListener} from 'node:http';
import {httpTransport} from '../scripts/liveuibench/transport.js';
async function fixture(handler:RequestListener,run:(base:string)=>Promise<void>){
 const server=createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{await run(`http://127.0.0.1:${(server.address() as any).port}`);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
test('HTTP deadline permits delayed headers and streamed body within selected timeout',async()=>{
 await fixture((req,res)=>{const timer=setTimeout(()=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"ok":');const end=setTimeout(()=>res.end('true}'),70);res.on('close',()=>clearTimeout(end));},70);res.on('close',()=>clearTimeout(timer));},async base=>{
  assert.deepEqual(await httpTransport(base,'fixture',1000).request('/delayed'),{ok:true});
 });
});
test('HTTP headers and body both obey deadline with diagnostic cause preserved',async()=>{
 for(const phase of ['headers','body'])await fixture((req,res)=>{if(phase==='body'){res.writeHead(200,{'content-type':'application/json'});res.write('{');}},async base=>{
  const started=Date.now();await assert.rejects(httpTransport(base,'fixture',120).request('/'+phase),(error:any)=>{
   assert.match(error.message,/HTTP transport failed.*ETIMEDOUT/);assert.equal(error.cause.code,'ETIMEDOUT');assert.deepEqual(Object.keys(error.cause),['code']);assert.ok(!JSON.stringify(error.cause).includes('Authorization'));return true;
  });assert.ok(Date.now()-started<1500,'deadline must terminate a stalled response');
 });
});
test('HTTP asynchronous job polling shares generation deadline',async()=>{
 let polls=0;const routes:string[]=[];
 await fixture((req,res)=>{routes.push(req.url!);res.setHeader('content-type','application/json');if(req.url==='/generate'){res.writeHead(202);res.end(JSON.stringify({jobId:'fixture',status:'running'}));}else{polls++;res.end(JSON.stringify({status:'running'}));}},async base=>{
  const started=Date.now();await assert.rejects(httpTransport(base,'fixture',650).request('/generate',{}),(error:any)=>{assert.equal(error.code??error.cause?.code,'ETIMEDOUT');return true;});
  assert.equal(polls,1);assert.deepEqual(routes,['/generate','/agent/complete/jobs/fixture']);assert.ok(Date.now()-started<1600,'polls must not restart full deadline');
 });
});
