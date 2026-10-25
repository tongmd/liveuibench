export type NativeGuiStep={kind:'fill'|'select'|'check'|'click'|'done'|'unsupported';target?:string;value?:string;checked?:boolean;reason?:string};
/** Runs only in Puppeteer's isolated realm. IDs never enter app HTML or its JS realm. */
export function nativeGuiSurface(operation:'snapshot'|'resolve',target?:string):any{
 const scope:any=globalThis;
 const state=scope.__nativeGuiIds||(scope.__nativeGuiIds={ids:new WeakMap(),tickets:new Map(),next:0});
 const root=document.querySelector('.a2ui-host');if(!root)throw Error('Native component surface missing');
 const visible=(e:Element)=>{const r=e.getBoundingClientRect();return e.isConnected&&r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';};
 const label=(e:any)=>e.getAttribute('data-a2ui-label')||e.closest('.a2ui-field')?.getAttribute('data-a2ui-label')||e.getAttribute('aria-label')||[...(e.labels||[])].map((n:any)=>n.textContent).join(' ')||e.closest('.a2ui-field')?.querySelector('label')?.textContent||e.textContent||'';
 const rowText=(e:any)=>{const list=e.closest('.a2ui-list');if(!list)return '';let row=e;while(row.parentElement&&row.parentElement!==list)row=row.parentElement;return row.parentElement===list?row.innerText||'':'';};
 const signature=(e:any)=>JSON.stringify([e.tagName,e.type,e.name,label(e),e.getAttribute('data-a2ui-action-id'),e.hasAttribute('data-a2ui-action-id')?rowText(e):null,e.getAttribute('data-a2ui-component-id'),e.closest('.a2ui-field')?.getAttribute('data-a2ui-component-id'),e.matches('.a2ui-choices[role=radiogroup]')?[...e.querySelectorAll('button.a2ui-choice')].filter(visible).map((b:any)=>[b.innerText,b.disabled]):null,e.disabled,e.readOnly,e instanceof HTMLSelectElement?[...e.options].map(o=>[o.value,o.text,Boolean(o.disabled||(o.parentElement instanceof HTMLOptGroupElement&&o.parentElement.disabled))]):null]);
 if(operation==='resolve'){
  const ticket=state.tickets.get(target);if(!ticket||!root.contains(ticket.element)||!visible(ticket.element)||signature(ticket.element)!==ticket.signature)throw Error('Stale or changed Native GUI target');
  return ticket.element;
 }
 state.tickets.clear();
 const issue=(e:any)=>{let id=state.ids.get(e);if(!id){id='e'+(++state.next);state.ids.set(e,id);}state.tickets.set(id,{element:e,signature:signature(e)});return id;};
 const fields=[...root.querySelectorAll('input:not([type=hidden]),textarea,select,.a2ui-choices[role=radiogroup],button[role=switch]')].filter(visible).map((node:any)=>({target:issue(node),...(node.getAttribute('data-a2ui-component-id')?{componentId:node.getAttribute('data-a2ui-component-id')}:{}),label:label(node).trim(),tag:node.tagName.toLowerCase(),type:node.matches('.a2ui-choices[role=radiogroup]')?'choice':node.getAttribute('role')==='switch'?'switch':node.type||'text',value:node.matches('.a2ui-choices[role=radiogroup]')?[...node.querySelectorAll('button.a2ui-choice[aria-pressed=true]')].filter(visible).map((b:any)=>b.innerText.trim()).join(', '):node.type==='password'?'[redacted]':node.value||'',checked:node.getAttribute('role')==='switch'?node.getAttribute('aria-checked')==='true':['checkbox','radio'].includes(node.type)?node.checked:undefined,required:Boolean(node.required),disabled:Boolean(node.disabled),readOnly:Boolean(node.readOnly),options:node.matches('.a2ui-choices[role=radiogroup]')?[...node.querySelectorAll('button.a2ui-choice')].filter(visible).map((b:any)=>({value:b.innerText.trim(),label:b.innerText.trim(),disabled:Boolean(b.disabled)})):node.tagName==='SELECT'?[...node.options].map((o:any)=>({value:o.value,label:o.text,disabled:Boolean(o.disabled||(o.parentElement instanceof HTMLOptGroupElement&&o.parentElement.disabled))})):undefined}));
 const buttons=[...root.querySelectorAll('[data-a2ui-action-id]')].filter(visible).map((node:any)=>({target:issue(node),...(node.getAttribute('data-a2ui-component-id')?{componentId:node.getAttribute('data-a2ui-component-id')}:{}),label:label(node).trim(),actionId:node.getAttribute('data-a2ui-action-id'),contextText:rowText(node),disabled:Boolean(node.disabled)}));
 return{fields,buttons,visibleText:(root as HTMLElement).innerText};
}
export async function readNativeGuiSurface(page:any){return page.mainFrame().isolatedRealm().evaluate(`(()=>{const __name=(fn)=>fn;return (${nativeGuiSurface.toString()})('snapshot');})()`);}
/** Wait before arming the write gate. A visible element may still be moving in
 * the product's opening sheet animation; coordinate clicks are unsafe then. */
export async function waitForNativeGuiClickReady(page:any,step:NativeGuiStep,deadline:number){
 if(step.kind!=='click'||!step.target)throw Error('Native GUI actionable wait requires a click target');
 const realm=page.mainFrame().isolatedRealm();
 const handle=await realm.evaluateHandle(`(()=>{const __name=(fn)=>fn;return (${nativeGuiSurface.toString()})('resolve',${JSON.stringify(step.target)});})()`);
 try{
  const element=handle.asElement();if(!element)throw Error('Native GUI target is not an element');
  await element.scrollIntoView();
  const ready=await realm.waitForFunction((e:Element)=>{
   if(!e.isConnected)return false;
   const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;
   const hit=document.elementFromPoint(x,y);if(!hit||!(hit===e||e.contains(hit)))return false;
   for(let node:Element|null=e;node;node=node.parentElement)if(node.getAnimations().some(a=>a.playState==='running'||a.pending))return false;
   const scope:any=globalThis;const prior=scope.__nativeGuiClickReady;
   const rect=[r.x,r.y,r.width,r.height];const now=performance.now();
   if(!prior||prior.element!==e||rect.some((v,i)=>Math.abs(v-prior.rect[i])>0.25)){scope.__nativeGuiClickReady={element:e,rect,since:now};return false;}
   return now-prior.since>=100;
  },{polling:'raf',timeout:Math.max(1,deadline-Date.now())},element);await ready.dispose();
  // Re-resolve after waiting: a rerender or changed row cannot inherit this ticket.
  const fresh=await realm.evaluateHandle(`(()=>{const __name=(fn)=>fn;return (${nativeGuiSurface.toString()})('resolve',${JSON.stringify(step.target)});})()`);await fresh.dispose();
 }finally{await handle.dispose();}
}
export async function applyNativeGuiStep(page:any,step:NativeGuiStep){
 const realm=page.mainFrame().isolatedRealm();
 if(!step.target)throw Error('Native GUI step lacks target');
 const handle=await realm.evaluateHandle(`(()=>{const __name=(fn)=>fn;return (${nativeGuiSurface.toString()})('resolve',${JSON.stringify(step.target)});})()`);
 try{
  const element=handle.asElement();if(!element)throw Error('Native GUI target is not an element');
  await element.evaluate((e:any,action:NativeGuiStep)=>{
   if(e.disabled||e.readOnly)throw Error('Native GUI target is disabled');
   if(action.kind==='click'){if(!e.hasAttribute('data-a2ui-action-id'))throw Error('Native GUI click lacks actual action binding');return;}
   if(e.hasAttribute('data-a2ui-action-id'))throw Error('Native GUI field target is an action');
   if(action.kind==='select'){
    if(e.matches('.a2ui-choices[role=radiogroup]')){const options=[...e.querySelectorAll('button.a2ui-choice')].filter((b:any)=>{const r=b.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(b).visibility!=='hidden'&&b.innerText.trim()===action.value&&!b.disabled;});if(options.length!==1)throw Error('Native GUI choice value is unavailable or ambiguous');options[0].click();return;}
    if(!(e instanceof HTMLSelectElement)||![...e.options].some(o=>o.value===action.value&&!o.disabled&&!(o.parentElement instanceof HTMLOptGroupElement&&o.parentElement.disabled)))throw Error('Native GUI select value is unavailable');
    e.value=action.value;
   }else if(action.kind==='check'){
    if(e.getAttribute('role')==='switch'){if(typeof action.checked!=='boolean')throw Error('Native GUI switch requires checked boolean');if((e.getAttribute('aria-checked')==='true')!==action.checked)e.click();return;}
    if(!(e instanceof HTMLInputElement)||!['checkbox','radio'].includes(e.type)||typeof action.checked!=='boolean')throw Error('Native GUI check target is invalid');
    if(e.checked!==action.checked)e.click();if(e.checked!==action.checked)throw Error('Native GUI checked state was rejected by the control');return;
   }else if(action.kind==='fill'){
    if(!(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement)||['checkbox','radio','file','button','submit','hidden','password'].includes(e.type)||typeof action.value!=='string')throw Error('Native GUI fill target is invalid');
    const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(e,action.value);
    if(e.value!==action.value)throw Error('Native GUI value rejected by input type');
   }else throw Error('Unsupported Native GUI field operation');
   e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));
  },step);
  if(step.kind==='click')await element.click();
  await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
  await element.evaluate((e:any,action:NativeGuiStep)=>{if(action.kind==='check'&&e.getAttribute('role')==='switch'&&(e.getAttribute('aria-checked')==='true')!==action.checked)throw Error('Native GUI switch state was rejected');if(action.kind==='select'&&e.matches('.a2ui-choices[role=radiogroup]')&&![...e.querySelectorAll('button.a2ui-choice[aria-pressed=true]')].some((b:any)=>b.innerText.trim()===action.value))throw Error('Native GUI choice state was rejected');},step);
 }finally{await handle.dispose();}
}

/** Wait for the actual surface opening paint, without disabling animations or
 * waiting for unrelated descendant/infinite decorative animations. */
export async function waitForNativeSurfaceReady(page:any,deadline:number){
 const remaining=deadline-Date.now();if(remaining<=0)throw Error('Native surface readiness deadline exceeded');
 const handle=await page.mainFrame().isolatedRealm().waitForFunction(()=>{
  const root=document.querySelector('.a2ui-host');if(!root)return false;
  const nodes:Element[]=[];for(let n:Element|null=root;n;n=n.parentElement)nodes.push(n);
  for(const n of nodes)for(const a of n.getAnimations()){
   const end=a.effect?.getComputedTiming().endTime;
   if(typeof end==='number'&&Number.isFinite(end)&&(a.playState==='running'||a.pending))return false;
  }
  const rect=root.getBoundingClientRect();if(!rect.width||!rect.height)return false;
  const signature=JSON.stringify(nodes.map(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return[r.x,r.y,r.width,r.height,s.visibility,s.opacity,s.filter,s.transform,s.clipPath];}));
  const state=(globalThis as any).__liveuiSurfacePaint;
  if(state?.root!==root||state.signature!==signature){(globalThis as any).__liveuiSurfacePaint={root,signature,frames:0};return false;}
  return ++state.frames>=2;
 },{polling:'raf',timeout:remaining});await handle.dispose();
}
