import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import puppeteer from 'puppeteer-core';
import {nativeChromeExecutable,nativeFetchAcknowledgementBootstrap,waitForNativeFetchAcknowledgement} from '../scripts/liveuibench/native-browser-support.js';

test('Native browser discovers explicit, environment, and installed Linux executables without a Mac dependency',async()=>{
 const installed=new Set(['/usr/bin/google-chrome']);const seen:string[]=[];
 const access=async(file:string)=>{seen.push(file);if(!installed.has(file))throw Error('not installed');};
 assert.equal(await nativeChromeExecutable(undefined,{},access),'/usr/bin/google-chrome');assert.ok(seen.includes('/usr/bin/chromium'));
 installed.add('/env/chrome');assert.equal(await nativeChromeExecutable(undefined,{PUPPETEER_EXECUTABLE_PATH:'/env/chrome'},access),'/env/chrome');
 installed.add('/selected/chrome');assert.equal(await nativeChromeExecutable('/selected/chrome',{CHROME_PATH:'/env/chrome'},access),'/selected/chrome');
 installed.clear();await assert.rejects(nativeChromeExecutable(undefined,{},access),(e:any)=>e.code==='evaluator_browser_unavailable'&&e.status===503);
});

test('Native fetch ACK waits for delayed body consumption and its readback continuation before visible snapshot',async t=>{
 let releaseAction!:()=>void,releaseQuery!:()=>void,actionSeen!:()=>void,querySeen!:()=>void;let actions=0,queries=0;
 const actionGate=new Promise<void>(r=>releaseAction=r),queryGate=new Promise<void>(r=>releaseQuery=r),actionStarted=new Promise<void>(r=>actionSeen=r),queryStarted=new Promise<void>(r=>querySeen=r);
 const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/agent/action'){actions++;actionSeen();res.write('{"ok":');await actionGate;return res.end('true}');}
  if(req.url==='/agent/query-state'){queries++;querySeen();res.write('{"record":');await queryGate;return res.end('"Observed record42"}');}
  res.setHeader('content-type','text/html');res.end('<button id="run">Run</button><div id="result">Old visible state</div><script>document.querySelector("#run").onclick=async()=>{await(await fetch("/agent/action",{method:"POST"})).json();const data=JSON.parse(await(await fetch("/agent/query-state")).text());queueMicrotask(()=>requestAnimationFrame(()=>document.querySelector("#result").textContent=data.record));};</script>');
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));let browser:any;
 t.after(async()=>{releaseAction();releaseQuery();if(browser)await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 browser=await puppeteer.launch({executablePath:await nativeChromeExecutable(),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();await page.evaluateOnNewDocument(nativeFetchAcknowledgementBootstrap);await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
 const turn=await page.evaluate(()=>(window as any).__liveuiBenchNativeFetch.begin());await page.click('#run');await actionStarted;
 let settled=false;const waiting=waitForNativeFetchAcknowledgement(page,turn,Date.now()+15000).then(()=>{settled=true;});
 await new Promise(r=>setTimeout(r,250));assert.equal(settled,false,'HTTP headers and a Node result cannot stand in for response.json consumption');assert.equal(await page.$eval('#result',(e:Element)=>e.textContent),'Old visible state');
 releaseAction();await queryStarted;await new Promise(r=>setTimeout(r,250));assert.equal(settled,false,'the app continuation readback remains pending after action consumption');
 releaseQuery();await waiting;assert.equal(await page.$eval('#result',(e:Element)=>e.textContent),'Observed record42');assert.equal(actions,1);assert.equal(queries,1,'waiting must not resend business/readback requests');
 await page.evaluate(()=>{document.querySelector<HTMLButtonElement>('#run')!.onclick=()=>{void fetch('/agent/action',{method:'POST'});};});
 const unreadTurn=await page.evaluate(()=>(window as any).__liveuiBenchNativeFetch.begin());await page.click('#run');await assert.rejects(waitForNativeFetchAcknowledgement(page,unreadTurn,Date.now()+250),(e:any)=>e.code==='evaluator_ui_ack_timeout'&&e.unresolved===true);assert.equal(actions,2,'unread response is not automatically retried');
});
