import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CompleteAppBrowser} from '../scripts/liveuibench/complete-browser.js';
import {validateBrowserDelivery} from '../liveuiagent/packages/dsh-plugin/browser-delivery.mjs';
async function chrome(){for(const p of [process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'])if(p){try{await fs.access(p);return p}catch{}}return undefined;}
const documentFor=(form:string)=>`<!doctype html><html><head></head><body><h1>Observed records</h1>${form}<output id="result"></output><section data-liveui-view="records"></section><script>document.querySelector('#liveui-task-form').addEventListener('submit',async e=>{e.preventDefault();const reply=await window.liveuiagent.ai(document.querySelector('#liveui-task').value,{});document.querySelector('#result').textContent=reply.ok===true?reply.text:reply.error||reply.text;if(reply.ok===true){const records=document.querySelector('[data-liveui-view=records]');records.replaceChildren();for(const entity of reply.data?.entities||[]){const row=document.createElement('article');row.textContent=[entity.name,entity.detail,entity.group].filter(value=>typeof value==='string'&&value).join(' · ');records.appendChild(row);}}});</script></body></html>`;
async function compare(t:any,form:string,accepted:boolean){
 const executable=await chrome();if(!executable){t.skip('Chrome unavailable; gate/driver parity unexecuted');return;}
 const html=documentFor(form);const gate=await validateBrowserDelivery(html,{chrome:executable,requireAgentAction:true});assert.equal(gate.ok,accepted,JSON.stringify(gate));assert.equal(gate.businessBehaviorVerified,false);
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'primary-parity-'));let calls=0;
 const transport={async request(route:string,body?:any){if(route.endsWith('/action')){calls++;assert.equal(body.prompt,'Read my observed records');return{id:'fixture-job',status:'done',result:{ok:true,text:'Actual fixture host result',data:{entities:[{name:'Observed item'}],stats:[],evaluation:{pass:true,deficiencies:[]}}}};}return{html,store:{}};}};
 const browser=new CompleteAppBrowser(transport,'dsh_primary_parity_fixture',out,executable);
 try{await browser.open();if(accepted){const result=await browser.submit('Read my observed records');assert.equal(calls,1);assert.equal(result.bridgeResults.length,1);assert.match(result.gui.visibleText,/Actual fixture host result/);}else{await assert.rejects(browser.submit('Read my observed records'),/Ambiguous or unavailable/);assert.equal(calls,0);}}finally{await browser.close();await fs.rm(out,{recursive:true,force:true});}
}
// These exact form fragments are sampled from actual generated artifacts; only
// their page shell/SDK callback is controlled so this tests selection, not model quality.
for(const sample of ['amazon','spotify'])test(`gate and driver select the actual ${sample} form despite its unbound helper buttons`,async t=>{
 const form=await fs.readFile(new URL(`./fixtures/primary-controls/${sample}-form.html`,import.meta.url),'utf8');await compare(t,form,true);
});
const form='<form id="liveui-task-form" data-liveui-action="agent.invoke"><label>Task<textarea id="liveui-task" required></textarea></label><button type="submit" data-liveui-action="agent.invoke">Run</button><button type="button">Reset text</button></form>';
test('gate and driver reject two genuine submits inherited from a bound form',async t=>{await compare(t,form.replace('</form>','<button type="submit">Other submit</button></form>'),false);});
test('gate and driver reject an independently bound type=button control',async t=>{await compare(t,form+'<button type="button" data-liveui-action="agent.invoke">Other primary</button>',false);});
test('gate and driver honor external form= ownership without inheriting helper controls',async t=>{
 await compare(t,'<form id="liveui-task-form" data-liveui-action="agent.invoke"><button type="button">Preset</button></form><label>Task<textarea id="liveui-task" form="liveui-task-form" required></textarea></label><button form="liveui-task-form" type="submit" data-liveui-action="agent.invoke">Run</button><form><button>Unrelated submit</button></form>',true);
});
