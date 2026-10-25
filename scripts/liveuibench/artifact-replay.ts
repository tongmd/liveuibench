import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {Transport} from './transport.js';
export type ReplayConfiguration={caseId:string;manifestRoot:string;manifestSha256:string;importer:string;importerSha256:string;ownerPrefix:string;accountRoot:string;runtimeDb:string;receiptDir:string};
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
export async function readReplayConfiguration(file:string):Promise<ReplayConfiguration>{
 const config=JSON.parse(await fs.readFile(file,'utf8'));
 for(const field of ['manifestRoot','importer','accountRoot','runtimeDb','receiptDir'])if(typeof config[field]!=='string'||!path.isAbsolute(config[field]))throw Error('Artifact replay requires absolute management paths');
 for(const field of ['manifestSha256','importerSha256'])if(!/^[a-f\d]{64}$/.test(config[field]))throw Error('Artifact replay requires SHA-locked inputs');
 if(!/^strict12-/.test(config.ownerPrefix))throw Error('Artifact replay requires a unique isolated owner scope');
 if(hash(await fs.readFile(config.importer))!==config.importerSha256)throw Error('Artifact replay importer changed');
 if(hash(await fs.readFile(path.join(config.manifestRoot,'manifest.json')))!==config.manifestSha256)throw Error('Artifact replay manifest changed');
 return config;
}
function importArtifacts(configFile:string,owner:string,importer:string,groupIndex:number,intentionIndex:number,prompt:string):Promise<any>{
 return new Promise((resolve,reject)=>{
  // No provider settings or request bodies are passed/logged. The importer reads
  // only this explicit local management configuration and sealed artifacts.
  const child=spawn('python3',[importer,configFile,owner,String(groupIndex),String(intentionIndex),hash(prompt)],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});let stdout='',stderr='';
  child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);const timer=setTimeout(()=>child.kill('SIGTERM'),30000);
  child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('Artifact replay import refused: '+stderr.slice(0,500)));try{resolve(JSON.parse(stdout));}catch{reject(Error('Artifact importer did not return a receipt'));}});
 });
}
export async function reuseArtifact(transport:Transport,configFile:string,caseId:string,groupIndex:number,intentionIndex:number,prompt:string){
 const c=await readReplayConfiguration(configFile);if(c.caseId!==caseId)throw Error('Replay configuration case does not match selected case');
 const receipt=await importArtifacts(configFile,transport.user,c.importer,groupIndex,intentionIndex,prompt);
 const group=receipt.groups.find((x:any)=>x.groupIndex===groupIndex);
 if(!group||group.intentionIndex!==intentionIndex||group.promptSha256!==hash(prompt))throw Error('Replay ordered group/intention/prompt identity mismatch');
 if(!group.available)throw Error('Original delivered artifact unavailable: '+(group.reason||'missing generation'));
 // This is a real runtime request. The registered app/package is never built
 // from a mock response, hand-edited source HTML, or a new model generation.
 const state=await transport.request('/agent/query-state',{});
 const actual=(state.apps||[]).find((x:any)=>x.appId===group.appId);
 if(!actual?.appPackage||'dsh_'+actual.completeApp?.id!==group.appId)throw Error('Imported artifact was not registered by the actual runtime');
 return {type:'artifact_reused',appSummary:{appId:actual.appId,name:actual.name},appPackage:actual.appPackage,execution:{...group.execution,reusedArtifact:true,generationModelCalls:0},artifactReplay:{...group,sourceArtifactManifestSha256:c.manifestSha256},actualRuntimePackage:true};
}
