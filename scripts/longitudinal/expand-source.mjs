#!/usr/bin/env node
// Reproducible authored continuation of every original case and intention group.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const input=fs.readFileSync(path.join(root,'benchmarks/liveuibench.json'));
const original=JSON.parse(input);
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const objectHash=x=>hash(JSON.stringify(x));
const profiles={
 spotify:{noun:'music library',focus:'playlist names and saved tracks',alternate:'artist names and saved tracks',layout:'playlist sections',summary:'saved playlist and track counts'},
 todoist:{noun:'task workspace',focus:'project and task names',alternate:'task names and completion status',layout:'project sections',summary:'existing task and completion counts'},
 gmail:{noun:'mail workspace',focus:'sender and subject',alternate:'subject and sender',layout:'thread sections',summary:'existing thread and reply counts'},
 amazon:{noun:'shopping workspace',focus:'product names and quantities',alternate:'product names and saved list names',layout:'shopping list sections',summary:'existing item and list counts'},
 venmo:{noun:'payment workspace',focus:'participant names and transaction descriptions',alternate:'transaction descriptions and participant names',layout:'participant sections',summary:'existing request and transaction counts'},
 simple_note:{noun:'notes workspace',focus:'note titles and notebook names',alternate:'notebook names and note titles',layout:'notebook sections',summary:'existing note and notebook counts'},
 phone:{noun:'phone workspace',focus:'contact or alarm names',alternate:'saved labels and current status',layout:'existing contact or alarm sections',summary:'existing contact and alarm counts'},
 file_system:{noun:'file workspace',focus:'file names and full paths',alternate:'full paths and file names',layout:'folder sections',summary:'existing file and folder counts'},
 splitwise:{noun:'shared expense workspace',focus:'group and participant names',alternate:'expense descriptions and group names',layout:'group sections',summary:'existing group and expense counts'},
};
const q=x=>JSON.stringify(x);
function identity(c,g){return `For the existing application for ${q(c.scenario)}, specifically the original request ${q(c.intentions[g].intention)}, continue using that same application and its current ${c.apps.join(', ')} data.`;}
function anchors(c){return Object.entries(c.context??{}).filter(([,v])=>typeof v==='string'||typeof v==='number').slice(0,3).map(([k,v])=>`${k}: ${q(v)}`).join('; ');}
function build(c,g,track){
 const domain=profiles[c.apps[0]]??profiles.simple_note;
 const prefix=`${c.id}__g${g}__${track==='agent-memory'?'memory':'ui'}`;
 const baseline=`${prefix}__baseline`;
 const preserved=id=>[{id:`${id}-records`,type:'state-preserved',path:['records'],fromStep:baseline},{id:`${id}-actions`,type:'actions-preserved',fromStep:baseline}];
 const memory=(id,value)=>({id:`${id}-memory`,type:'memory-equals',scope:'app',key:`${prefix}.presentation`,value});
 const absent=id=>({id:`${id}-forgotten`,type:'memory-absent',scope:'app',key:`${prefix}.presentation`});
 const step=(name,kind,message,assertions=[])=>{const id=`${prefix}__${name}`;return {id,kind,...(message?{message}:{}),assertions:[...assertions,...preserved(id)]};};
 const session=(name,steps)=>({id:`${prefix}__${name}`,resetConversation:true,appKey:`source-group-${g}`,steps});
 const stateBaseline={id:`${baseline}-records`,type:'state-baseline',path:['records']};
 const actionsBaseline={id:`${baseline}-actions`,type:'actions-baseline'};
 const baseStep={id:baseline,kind:'reopen',assertions:[stateBaseline,actionsBaseline,...(track==='personalized-ui'?['font-size','display','flex-direction'].map(property=>({id:`${baseline}-${property}`,type:'dom-visible',selector:'@source.primaryRecords',property})):[]),...(track==='personalized-ui'?['width','height'].map(property=>({id:`${baseline}-action-${property}`,type:'dom-visible',selector:'@source.primaryActions',property})):[])]};
 const preserve=`Do not create another app, reseed examples, replay earlier sends or payments, or change any existing business record. Keep every original operation reachable. This request changes presentation preferences only.`;
 const context=anchors(c);
 const topic=`${identity(c,g)}${context?` Original task context: ${context}.`:''}`;
 let sessions;
 if(track==='agent-memory'){
  const learned={emphasis:domain.focus,showSummary:true};
  const corrected={emphasis:domain.alternate,showSummary:false};
  sessions=[
   session('learn',[baseStep,step('learn','message',`${topic} Remember for this app that I want ${domain.focus} emphasized in the existing ${domain.noun}, with a brief summary of ${domain.summary} derived only from its real current data. Apply it now. ${preserve}`,[memory(`${prefix}__learn`,learned)])]),
   session('retrieve',[step('return','reopen',null,[memory(`${prefix}__return`,learned)]),step('continue','message',`Open my existing ${c.scenario} workspace as I usually use it. Show the current saved information; do not repeat the original business actions.`,[memory(`${prefix}__continue`,learned)])]),
   session('correct',[step('correct','message',`${topic} Update my saved display preference: emphasize ${domain.alternate} instead, and stop showing the extra count summary. This replaces the earlier preference; do not store two conflicting defaults. ${preserve}`,[memory(`${prefix}__correct`,corrected)])]),
   session('retain-correction',[step('corrected-return','reopen',null,[memory(`${prefix}__corrected-return`,corrected)])]),
   session('forget',[step('forget','message',`${topic} Forget the display-emphasis and count-summary preference I taught you during these later sessions. Return those presentation choices to the original app's pre-extension defaults. Keep business information and the original working operations.`,[absent(`${prefix}__forget`)])]),
   session('verify-forgotten',[step('forgotten-return','reopen',null,[absent(`${prefix}__forgotten-return`)])]),
  ];
 }else{
  const selector='@source.primaryRecords';
  const font=id=>({id:`${id}-font`,type:'dom-style-number',selector,property:'font-size',min:20});
  const touch=id=>({id:`${id}-touch`,type:'dom-bounds',selector:'@source.primaryActions',minWidth:44,minHeight:44});
  const layout=(id,value)=>({id:`${id}-layout`,type:'dom-style',selector,property:'display',value});
  const comfortable={layout:'comfortable-sections',minFontSize:20,minTargetSize:44};
  const compact={layout:'compact-list',minFontSize:20,minTargetSize:44};
  const restored=id=>[...['font-size','display','flex-direction'].map(property=>({id:`${id}-${property}`,type:'dom-style-preserved',selector,property,fromStep:baseline})),...['width','height'].map(property=>({id:`${id}-action-${property}`,type:'dom-style-preserved',selector:'@source.primaryActions',property,fromStep:baseline}))];
  sessions=[
   session('adapt',[baseStep,step('adapt','message',`${topic} Make this same ${domain.noun} easier for me to read and operate: use at least 20px text in the primary records view and at least 44 by 44px controls for its primary operations. Organize its actual records into comfortable ${domain.layout}, keeping existing names, values, history and every working operation. Remember this as my app-specific display preference. Do not replace the task with a generic demo. ${preserve}`,[memory(`${prefix}__adapt`,comfortable),font(`${prefix}__adapt`),touch(`${prefix}__adapt`)])]),
   session('resume',[step('return','reopen',null,[memory(`${prefix}__return`,comfortable),font(`${prefix}__return`),touch(`${prefix}__return`)])]),
   session('reshape',[step('reshape','message',`${topic} I now want a compact single-column list of the same existing records rather than the comfortable sections. Keep the large 20px text and 44px controls. Use a real flex-column primary records view, with the original ${domain.focus} still visible; do not remove or simulate original operations to make it fit. Remember this layout change. ${preserve}`,[memory(`${prefix}__reshape`,compact),layout(`${prefix}__reshape`,'flex'),{id:`${prefix}__reshape-direction`,type:'dom-style',selector,property:'flex-direction',value:'column'},font(`${prefix}__reshape`),touch(`${prefix}__reshape`)])]),
   session('confirm-layout',[step('compact-return','reopen',null,[memory(`${prefix}__compact-return`,compact),layout(`${prefix}__compact-return`,'flex'),font(`${prefix}__compact-return`),touch(`${prefix}__compact-return`)])]),
   session('restore',[step('restore','message',`${topic} Restore the primary view's original layout and text/control sizes from before these later customization sessions, and forget the later display override. Keep all original saved records, original actions and their values intact. Do not recreate the original data from examples.`,[absent(`${prefix}__restore`),...restored(`${prefix}__restore`)])]),
   session('confirm-restored',[step('restored-return','reopen',null,[absent(`${prefix}__restored-return`),...restored(`${prefix}__restored-return`)])]),
  ];
 }
 return {schemaVersion:'liveuibench.longitudinal.v1',id:prefix,track,source:{kind:'source-case-expansion',caseId:c.id,split:c.split,caseSha256:objectHash(c),sourceGroupIndex:g,intentionSha256:objectHash(c.intentions[g]),apps:c.apps,scenario:c.scenario,executionStatus:'not-run',authoringMethod:'deterministic authored continuation with source scenario, intention and literal context; no model-generated or measured outcomes'},sourceBootstrap:{caseId:c.id,caseSha256:objectHash(c),sourceGroupIndex:g,intentionSha256:objectHash(c.intentions[g]),mode:'execute-original-case',preserveOwnerAndApp:true,requireAllEpisodes:true},owner:'source-owner',sessions};
}
const cases=original.cases.map(c=>{const extensions=c.intentions.flatMap((_,g)=>[build(c,g,'agent-memory'),build(c,g,'personalized-ui')]);return {...c,extensionIds:extensions.map(e=>e.id),longitudinalExtensions:extensions};});
const extensions=cases.flatMap(c=>c.longitudinalExtensions);
const counts={sourceCases:cases.length,sourceGroups:original.cases.reduce((n,c)=>n+c.intentions.length,0),extensions:extensions.length,sessions:extensions.reduce((n,e)=>n+e.sessions.length,0),addedSteps:extensions.reduce((n,e)=>n+e.sessions.reduce((m,s)=>m+s.steps.length,0),0),addedAssertions:extensions.reduce((n,e)=>n+e.sessions.reduce((m,s)=>m+s.steps.reduce((k,t)=>k+t.assertions.length,0),0),0),inheritedEpisodes:original.cases.reduce((n,c)=>n+c.episodes.length,0)};
const expanded={...original,name:'LiveUIBench Expanded',schemaVersion:'liveuibench.source-expanded.v1',expansion:{sourceFile:'benchmarks/liveuibench.json',sourceFileSha256:hash(input),objectHashEncoding:'UTF-8 JSON.stringify original parsed object, preserving source key order',executionStatus:'not-run',counts,protocol:'Each continuation starts with its own fresh original case execution, preserving the complete original sequence, fixture and app-group identities. Scores remain separate from the original protocol.',observationContract:{state:'records is a lossless canonical persistent business-state projection read from the original services/app state; unsupported if absent; empty is valid only with an independently confirmed empty source baseline',actions:'all original action identities and actual reachability from runtime/UI readback, not names copied from requirements',memory:'presentation keys are semantic adapter-normalized preferences, not required internal storage names; values must be derived from persistent memory readback',selectors:{'@source.primaryRecords':'the real original app primary business-records container, identified by the adapter; never a synthetic test-only mirror','@source.primaryActions':'every real original app primary operation control, identified by the adapter'},bootstrap:'Every original intention group and episode must be executed in order before continuation; no generic seed replacement, no hidden-gold exposure; unsupported bootstrap retains full denominator'}},cases};
const output=JSON.stringify(expanded,null,2)+'\n';
const provenance={schemaVersion:'liveuibench.source-expansion-provenance.v1',sourceFile:expanded.expansion.sourceFile,sourceFileSha256:hash(input),expandedFileSha256:hash(output),counts,sourceCases:original.cases.map(c=>({caseId:c.id,split:c.split,caseSha256:objectHash(c),intentionSha256s:c.intentions.map(objectHash),episodeSha256:objectHash(c.episodes),extensionIds:cases.find(x=>x.id===c.id).extensionIds})),coverageLimitations:['These continuations evaluate explicit app-scoped presentation preference acquisition, correction, forgetting, and interface continuity in original task applications; they do not establish autonomous episodic memory extraction or learned domain-business policy.', 'A shared controlled six-session structure is reused for each original intention group; 672 continuations are not 672 independent new source scenarios.', 'UI size checks target the actual primary container and primary controls exposed by a verified adapter; this is not an exhaustive accessibility audit.', 'No real runtime adapter or model execution is bundled by the data generator; unsupported implementations must retain the denominator.'],authorship:'Authored deterministic expansion from all original source scenarios. Repeated continuation structure is deliberate controlled evaluation design, not additional independent source tasks.',measuredResults:null};
fs.writeFileSync(path.join(root,'benchmarks/liveuibench-expanded.json'),output);
fs.writeFileSync(path.join(root,'benchmarks/liveuibench-expanded.provenance.json'),JSON.stringify(provenance,null,2)+'\n');
console.log(JSON.stringify(counts));
