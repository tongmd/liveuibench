import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {planFormSubmission} from '../scripts/liveuibench/form-submission.js';
import {CompleteAppBrowser} from '../scripts/liveuibench/complete-browser.js';
const field=(label:string,type='text',extra:any={})=>({target:label,label,tag:'input',type,...extra});
test('mapping uses explicit visible labels and typed values without flooding every field',()=>{
 const fields=[field('Title'),field('Amount','number'),field('Date','date'),field('Category','',{tag:'select',options:[{value:'travel',label:'Travel'}]})];
 assert.deepEqual(planFormSubmission(fields,'Title: Train ticket; Amount: 25.5; Date: 2026-10-25; Category: Travel').map(x=>[x.kind,x.value]),[['fill','Train ticket'],['fill','25.5'],['fill','2026-10-25'],['select','travel']]);
 assert.equal(planFormSubmission([field('Instruction')],'Find the best route')[0].value,'Find the best route');
 assert.throws(()=>planFormSubmission(fields,'Make a train ticket for tomorrow'),/Unsupported/);
 assert.throws(()=>planFormSubmission(fields,'Amount: many'),/invalid number/);
 assert.throws(()=>planFormSubmission(fields,'Date: 2026-02-30'),/invalid ISO date/);
 assert.throws(()=>planFormSubmission(fields,'Category: Other'),/unknown or ambiguous/);
 assert.throws(()=>planFormSubmission([field('Amount'),field('Amount')],'Amount: 2'),/ambiguous/);
 assert.throws(()=>planFormSubmission([field('Required','text',{required:true}),field('Other')],'Other: 2'),/missing required/);
 assert.throws(()=>planFormSubmission(fields,'Title: A; Title: B'),/duplicate/);
});
test('real Chrome fills text/number/date/select, invokes the host bridge and preserves saved records',async t=>{
 let chrome:string|undefined;
 for(const candidate of [process.env.CHROME_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome']) {if(!candidate)continue;try{await fs.access(candidate);chrome=candidate;break;}catch{}}
 if(!chrome){t.skip('Chrome unavailable; real form interaction is unexecuted');return;}

 const out=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-form-driver-'));
 const appId='dsh_form_fixture'; let store:Record<string,string>={}; const requests:any[]=[];
 const html=`<!doctype html><html><body><h1>Expenses</h1><label>Title<input id="title" required></label><label>Amount<input id="amount" type="number" required></label><label>Date<input id="date" type="date" required></label><label>Category<select id="category"><option value="">Choose</option><option value="travel">Travel</option></select></label><button id="save">Save</button><output id="result"></output><script>
 const controls=['title','amount','date','category']; const result=document.getElementById('result');
 if(localStorage.getItem('saved')) {const record=JSON.parse(localStorage.getItem('saved')); for(const id of controls)document.getElementById(id).value=record[id];result.textContent=localStorage.getItem('saved');}
 document.getElementById('save').onclick=async()=>{const data=Object.fromEntries(controls.map(id=>[id,document.getElementById(id).value]));await liveuiagent.ai('Save expense',data);localStorage.setItem('saved',JSON.stringify(data));result.textContent=localStorage.getItem('saved');};
 </script></body></html>`;
 const evidence={schemaVersion:1,appId,trace:[{agent:'orchestrator'}],toolResults:{},toolDbChanges:[]};
 const transport={async request(route:string,body?:any,method?:string){
  if(route.endsWith('/store')){store={...body};return{ok:true};}
  if(route.endsWith('/action')){requests.push(body);return{id:'host-job',status:'done',evidence,result:{ok:true}};}
  return{html,store};
 }};
 const browser=new CompleteAppBrowser(transport,appId,out,chrome);
 try {
  await browser.open();
  await assert.rejects(browser.submit('Add a train ticket tomorrow'),/Unsupported/);assert.equal(requests.length,0);assert.deepEqual(store,{});
  const result=await browser.submit('Title: Train ticket; Amount: 25.5; Date: 2026-10-25; Category: Travel');
  const expected={title:'Train ticket',amount:'25.5',date:'2026-10-25',category:'travel'};
  assert.deepEqual(requests[0].context,expected);assert.deepEqual(JSON.parse(store.saved),expected);
  assert.equal(requests.length,1);assert.deepEqual(result.bridgeResults[0].evidence,evidence);
  await browser.close();await browser.open();assert.deepEqual(JSON.parse(store.saved),expected);assert.match((await browser.snapshot()).visibleText,/Train ticket/);
 } finally {await browser.close();await fs.rm(out,{recursive:true,force:true});}
});

test('selected button scopes required fields to its native form including external form-associated controls',async t=>{
 let chrome:string|undefined;
 for(const candidate of [process.env.CHROME_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome']) {if(!candidate)continue;try{await fs.access(candidate);chrome=candidate;break;}catch{}}
 if(!chrome){t.skip('Chrome unavailable; form ownership interaction is unexecuted');return;}
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-form-ownership-'));const requests:any[]=[];
 const html=`<!doctype html><html><body><h1>Workspace</h1>
 <form id="commands"><button>Run command</button></form>
 <label>Task command<input id="command" form="commands" required></label>
 <form id="entities"><label>Title<input id="title" required></label><button>Save entity</button></form>
 <output id="result"></output><script>
 document.getElementById('commands').onsubmit=async event=>{event.preventDefault();const value=document.getElementById('command').value;await liveuiagent.ai(value,{form:'commands',command:value,title:document.getElementById('title').value});document.getElementById('result').textContent=value;};
 document.getElementById('entities').onsubmit=async event=>{event.preventDefault();const value=document.getElementById('title').value;await liveuiagent.ai(value,{form:'entities',command:document.getElementById('command').value,title:value});document.getElementById('result').textContent=value;};
 </script></body></html>`;
 const transport={async request(route:string,body?:any){if(route.endsWith('/action')){requests.push(body);return{id:'job-'+requests.length,status:'done',result:{ok:true}};}return{html,store:{}};}};
 const browser=new CompleteAppBrowser(transport,'dsh_forms_fixture',out,chrome);
 try {
  await browser.open();
  const command=await browser.submit('Find my saved notes',1);
  assert.deepEqual(command.selection.fields,['Task command']);assert.equal(requests.length,1);
  assert.deepEqual(requests[0].context,{form:'commands',command:'Find my saved notes',title:''});
  const entity=await browser.submit('A specific title',2);
  assert.deepEqual(entity.selection.fields,['Title']);assert.equal(requests.length,2);
  assert.deepEqual(requests[1].context,{form:'entities',command:'Find my saved notes',title:'A specific title'});
  assert.equal(entity.bridgeResults.length,1);assert.equal(entity.bridgeResults[0].id,'job-2');
 } finally {await browser.close();await fs.rm(out,{recursive:true,force:true});}
});
