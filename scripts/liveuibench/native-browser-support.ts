import fs from 'node:fs/promises';

export async function nativeChromeExecutable(chrome?:string,env:Record<string,string|undefined>=process.env,accessible:(file:string)=>Promise<unknown>=file=>fs.access(file)) {
 for(const candidate of [chrome,env.CHROME_PATH,env.PUPPETEER_EXECUTABLE_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/snap/bin/chromium']){
  if(!candidate)continue;try{await accessible(candidate);return candidate;}catch{/* Try the next installed browser, as the HTML driver does. */}
 }
 throw Object.assign(Error('Chrome is required for Native renderer evaluation; configure CHROME_PATH or PUPPETEER_EXECUTABLE_PATH.'),{status:503,code:'evaluator_browser_unavailable'});
}

// Evaluator instrumentation only: preserve the product fetch and response values.
// Resolving the body promise first queues the application's awaiting continuation
// before our microtask/two-frame ACK. Its immediate query-state fetch is therefore
// tracked before the action can settle. Receiving HTTP headers is not an ACK.
export const nativeFetchAcknowledgementBootstrap=String.raw`(()=>{
 const originalFetch=window.fetch.bind(window);const pending=new Map();let sequence=0,turn=0,version=0,completedActions=0;
 const frames=callback=>queueMicrotask(()=>requestAnimationFrame(()=>requestAnimationFrame(callback)));
 const finish=entry=>{if(entry.finishing)return;entry.finishing=true;frames(()=>{pending.delete(entry.id);version++;if(entry.turn===turn&&entry.action)completedActions++;});};
 const state={begin(){turn++;completedActions=0;version++;return turn;},status(){return{turn,pending:pending.size,version,completedActions};}};
 Object.defineProperty(window,'__liveuiBenchNativeFetch',{value:state});
 window.fetch=(input,init)=>{
  let route='';try{const u=new URL(typeof input==='string'?input:input.url,location.href);if(u.origin===location.origin)route=u.pathname.replace(/^\/liveui/,'');}catch{}
  // Only state-changing action and its authoritative readback require body ACK.
  // Shell metadata/history fetches may intentionally ignore their response body.
  if(route!=='/agent/action'&&route!=='/agent/query-state')return originalFetch(input,init);
  const entry={id:++sequence,turn,action:route==='/agent/action',finishing:false};pending.set(entry.id,entry);version++;
  return new Promise((resolve,reject)=>{
   originalFetch(input,init).then(response=>{
    resolve(new Proxy(response,{get(target,key){
     if(['json','text','arrayBuffer','blob','formData'].includes(key))return(...args)=>new Promise((resolveBody,rejectBody)=>{
      target[key](...args).then(value=>{resolveBody(value);finish(entry);},error=>{rejectBody(error);finish(entry);});
     });
     const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }}));
   },error=>{reject(error);finish(entry);});
  });
 };
})();`;

function acknowledgementTimeout(){return Object.assign(Error('Native UI response-consumption acknowledgement is unresolved; do not automatically retry this action.'),{code:'evaluator_ui_ack_timeout',unresolved:true});}
async function beforeDeadline<T>(work:Promise<T>,deadlineAt:number):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(acknowledgementTimeout()),Math.max(1,deadlineAt-Date.now()));})]);}finally{clearTimeout(timer);}
}

export async function waitForNativeFetchAcknowledgement(page:any,turn:number,deadlineAt:number) {
 while(Date.now()<deadlineAt){
  const state:any=await beforeDeadline(page.evaluate(()=> (window as any).__liveuiBenchNativeFetch.status()),deadlineAt);
  if(state.turn!==turn)throw Error('Native UI acknowledgement turn changed before completion');
  if(state.completedActions>0&&state.pending===0){
   const stable=await beforeDeadline(page.evaluate(async(expected:{turn:number;version:number})=>{
    await new Promise<void>(resolve=>queueMicrotask(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    const current=(window as any).__liveuiBenchNativeFetch.status();
    return current.turn===expected.turn&&current.version===expected.version&&current.pending===0&&current.completedActions>0;
   },state),deadlineAt);
   if(stable)return;
  }
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw acknowledgementTimeout();
}
