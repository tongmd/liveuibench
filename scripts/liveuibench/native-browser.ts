import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer-core';
import type {Transport} from './transport.js';
import {executableActionByOrdinal} from './scorer.js';

/** Uses the product's actual Native A2UI web renderer, not an alternate test
 * renderer. The local server supplies shell metadata; only explicit query/action
 * requests cross the trusted transport. Browser never receives credentials. */
export class NativeAppBrowser {
 private browser:any;private page:any;private server?:http.Server;private errors:string[]=[];private rendererSha='';private actionResult:any;private actionError:any;
 constructor(private transport:Transport,private appId:string,private out:string,private pkg:any,private harness:'native'|'dsh',private model:string,private chrome?:string,private rendererRoot=fileURLToPath(new URL('../../liveuiagent/frontend/snapshot/',import.meta.url)),private timeoutMs=900000){}
 async open(){
  const manifest=JSON.parse(await fs.readFile(path.join(this.rendererRoot,'manifest.json'),'utf8'));const resources=manifest.resources||[{file:manifest.file,sha256:manifest.sha256}];const files=new Map<string,Buffer>();
  for(const r of resources){if(!/^[a-zA-Z0-9_.-]+$/.test(r.file))throw Error('Unsafe Native renderer resource');const b=await fs.readFile(path.join(this.rendererRoot,r.file));if(createHash('sha256').update(b).digest('hex')!==r.sha256)throw Error('Native renderer source SHA mismatch');files.set(r.file,b);}
  if(!files.has('index.html'))throw Error('Native renderer missing entry point');this.rendererSha=createHash('sha256').update(files.get('index.html')!).digest('hex');
  this.server=http.createServer(async(req,res)=>{const json=(v:any,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(v));};try{const route=new URL(req.url!,'http://local').pathname.replace(/^\/liveui/,'')||'/';let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};
   if(route==='/agent/query-state')return json(await this.transport.request(route,body));
   if(route==='/agent/action'){try{if(body.appId!==this.appId)throw Error('Native renderer action target mismatch');this.actionResult=await this.transport.request(route,{...body,harness:this.harness,llm:{model:this.model}});return json(this.actionResult);}catch(e:any){this.actionError=e;return json({error:e.message},500);}}
   if(route==='/agent/settings')return json({user:{models:[]},server:{models:[this.model],hasApiKey:true},effective:{model:this.model,models:[this.model],keySource:'server'},warnings:[]});
   if(route==='/agent/runtime-settings')return json({harness:this.harness,choices:[{id:this.harness,label:this.harness,available:true}],model:{id:this.model,delivery:'native'}});
   if(route==='/agent/models')return json({models:[this.model],default:this.model});
   if(route==='/agent/personal')return json({layout:{},materialLayout:{},appearances:{},memories:[],apps:[],enabledShared:[],hidden:[]});
   if(route==='/agent/chat-history')return json({messages:[]});
   if(route==='/agent/chat-append')return json({id:1});
   if(route.startsWith('/agent/'))return json({error:'Unsupported renderer endpoint '+route},400);
   const name=route==='/'?'index.html':route.slice(1);const data=files.get(name);if(!data)return json({error:'Unknown renderer resource'},404);res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});res.end(data);
  }catch(e:any){json({error:e.message},500);}});
  await new Promise<void>(r=>this.server!.listen(0,'127.0.0.1',r));
  try{this.browser=await puppeteer.launch({executablePath:this.chrome||process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});this.page=await this.browser.newPage();await this.page.setViewport({width:1440,height:1000});this.page.on('pageerror',(e:any)=>this.errors.push(e.message));await this.page.goto(`http://127.0.0.1:${(this.server.address() as any).port}/liveui/`);await this.page.waitForFunction((id:string)=>[...document.querySelectorAll('[data-app-id]')].some(n=>n.getAttribute('data-app-id')===id),{timeout:15000},this.appId);const appHandle=await this.page.evaluateHandle((id:string)=>[...document.querySelectorAll('[data-app-id]')].find(n=>n.getAttribute('data-app-id')===id),this.appId);await appHandle.asElement().click({clickCount:2});await appHandle.dispose();await this.page.waitForSelector('.a2ui-host',{timeout:15000});}catch(e){if(this.page){await fs.mkdir(this.out,{recursive:true});await fs.writeFile(path.join(this.out,'native-open-failure.json'),JSON.stringify({errors:this.errors,text:await this.page.evaluate(()=>document.body.innerText)}));}await this.close();throw e;}
 }
 async snapshot(name:string){
  const dom=await this.page.$eval('.a2ui-host',(root:Element)=>{return{visibleText:(root as HTMLElement).innerText,inputCount:[...root.querySelectorAll('input,textarea,select')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';}).length,actionCount:[...root.querySelectorAll('[data-a2ui-action-id]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';}).length,iframeCount:root.querySelectorAll('iframe').length};});
  await fs.mkdir(this.out,{recursive:true});await this.page.screenshot({path:path.join(this.out,name+'.png'),fullPage:true});
  if(!dom.visibleText.trim()||dom.iframeCount||this.errors.length)throw Error('Native renderer did not produce an error-free visible component surface: '+this.errors.join('; '));
  return{...dom,evaluator:'actual-native-a2ui-browser',scope:'actual product renderer DOM; action click verified separately',rendererSha256:this.rendererSha,errors:[...this.errors],passed:Boolean(dom.visibleText.trim())&&dom.iframeCount===0&&this.errors.length===0};
 }
 async submit(message:string,ordinal=1){
  const {actionId}=executableActionByOrdinal(this.pkg,ordinal);
  // A natural-language episode cannot safely fill several structured fields.
  const inputs=await this.page.$$('.a2ui-host input:not([type=hidden]):not([type=checkbox]):not([type=radio]),.a2ui-host textarea');const editable=[];
  for(const h of inputs){if(await h.evaluate((e:HTMLInputElement)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled&&!e.readOnly;}))editable.push(h);}
  if(editable.length!==1)throw Error(`Unsupported Native GUI episode mapping: expected one visible free-text input, found ${editable.length}; no action was sent`);
  if(!await editable[0].evaluate((e:HTMLInputElement)=>!e.type||['text','search','textarea'].includes(e.type)))throw Error('Unsupported Native GUI episode input type; no action was sent');
  const label=await editable[0].evaluate((e:HTMLInputElement)=>e.getAttribute('aria-label')||[...(e.labels||[])].map(n=>n.textContent).join(' ')||e.closest('.a2ui-field')?.textContent||'');
  if(!/^(?:request|instruction|prompt|command|task|what .*(?:do|want)|请求|指令|任务)$/i.test(label.trim()))throw Error('Unsupported Native GUI input semantics: no unambiguous natural-language request field; no action was sent');
  await editable[0].click();await editable[0].evaluate((e:HTMLInputElement)=>e.select());await this.page.keyboard.press('Backspace');await editable[0].type(message);
  const buttons=await this.page.$$('.a2ui-host [data-a2ui-action-id]');let selected:any;
  for(const b of buttons){if(await b.evaluate((e:Element,id:string)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&[id,'actions.'+id].includes(e.getAttribute('data-a2ui-action-id')||'');},actionId)){if(selected)throw Error('Ambiguous Native GUI action binding');selected=b;}}
  if(!selected)throw Error('Native GUI lacks selected ordinal action binding');this.actionResult=undefined;this.actionError=undefined;await selected.click();
  const deadline=Date.now()+this.timeoutMs;while(this.actionResult===undefined&&!this.actionError){if(Date.now()>deadline)throw Error('Native GUI action response timed out');await new Promise(r=>setTimeout(r,50));}if(this.actionError)throw this.actionError;
  if(this.actionResult.appPackage)this.pkg=this.actionResult.appPackage;await new Promise(r=>setTimeout(r,150));return{actionResult:this.actionResult,gui:await this.snapshot('native-action'),interactionScope:'actual native renderer input and bound button click'};
 }
 async close(){
  const browser=this.browser;this.browser=null;
  if(browser){const child=browser.process();let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([browser.close(),new Promise<void>(r=>{timer=setTimeout(()=>{child?.kill('SIGTERM');r();},3000);})]);}finally{clearTimeout(timer);child?.stdin?.destroy();child?.stdout?.destroy();child?.stderr?.destroy();}
  }
  const server=this.server;this.server=undefined;
  if(server){server.closeAllConnections();if(server.listening)await new Promise<void>(r=>server.close(()=>r()));}
 }
}
