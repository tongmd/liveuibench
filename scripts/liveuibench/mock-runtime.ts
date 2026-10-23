import type {Transport} from './transport.js';
// Fixed, transparent offline fixture. It never reads assertion values or a model API.
export function mockTransport():Transport {
 let app:any;let turns=0;
 return {user:'offline-fixture',async request(route,body){
  if(route==='/agent/run'){
   const appId='mock-notebook';const components:any[]=[{id:'root',component:'Column',children:['title','topic','recipient','detail','save','saveText','preview','previewText','result']},{id:'title',component:'Text',text:{literal:'Notebook'},variant:'h1'},...['topic','recipient','detail'].map((id,i)=>({id,component:'TextField',label:['Topic','Recipient','Details'][i],value:{path:'/draft/'+id}})),{id:'save',component:'Button',child:'saveText',action:{event:{name:'agent_turn_1',context:{prompt:{path:'/draft/topic'}}}}},{id:'saveText',component:'Text',text:{literal:'Save note'}},{id:'preview',component:'Button',child:'previewText',action:{event:{name:'agent_turn_1',context:{prompt:{path:'/draft/topic'}}}}},{id:'previewText',component:'Text',text:{literal:'Review'}},{id:'result',component:'Text',text:{path:'/draft/result'}}];
   const pkg={manifest:{appId,name:'Notebook',intent:{kind:'agent_app'}},ui:{pages:[{id:'home',components:[{id:'input',type:'input'},{id:'save',type:'button',events:{click:'actions.agent_turn_1'}}]}],meta:{agentWorkflow:[{pageId:'home',actionRoutes:[{actionId:'actions.agent_turn_1',componentId:'save',payloadSource:'event.payload',payloadFields:['topic']}]}],a2ui:{protocol:'a2ui',renderer:'@a2ui/react',surfaceId:'main',initialData:{draft:{topic:'',recipient:'',detail:'',result:'Ready'}},messages:[{updateComponents:{surfaceId:'main',components}}]}}},actions:{actions:{agent_turn_1:{}}}};
   app={appId,name:'Notebook',appPackage:pkg,appData:{notes:[]},runtimeState:{}};return {type:'app_created',appPackage:pkg,execution:{harness:'native',model:'offline-fixture'},mock:true};
  }
  if(!app)throw new Error('Mock app not created');
  if(route==='/agent/action'){
   turns++;const note=turns===1?'Weekend plan':'Weekend plan updated';app.appData.notes=[{title:note}];app.runtimeState={intentResult:{summary:note},entities:[{title:note}]};app.appPackage.ui.meta.a2ui.initialData.draft.result=note;
   return {appPackage:app.appPackage,runtimeState:app.runtimeState,trace:[{agent:'Orchestrator',status:'ok'}],toolResults:{'appworld.simple_note.create_note':{tool:{appName:'simple_note',apiName:'create_note'},result:{title:note}}},toolDbChanges:[{appName:'simple_note',delta:1}],mock:true};
  }
  if(route==='/agent/patch-app'){app.appPackage.manifest.version='2';return {appPackage:app.appPackage,mock:true};}
  if(route==='/agent/query-state')return {apps:[structuredClone(app)],mock:true};
  throw new Error('Unsupported mock route '+route);
 }};
}
