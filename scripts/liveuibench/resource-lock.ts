import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
const releases=new Set<()=>Promise<void>>();
export async function releaseOwnedResources(){await Promise.all([...releases].map(release=>release()));}

// Cross-process exclusion: two CLI invocations must never reset the same world
// or use the same runtime concurrently. Locks deliberately fail closed after a crash.
export async function lockResources(resources:string[], root=path.join(os.tmpdir(),'liveuibench-resource-locks')) {
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const held:{dir:string;token:string}[]=[];
  let releasing:Promise<void>|undefined;
  async function release(){
   if(releasing)return releasing;
   releasing=(async()=>{
    for(const {dir,token} of held.reverse()) {
      const owner=JSON.parse(await fs.readFile(path.join(dir,'owner.json'),'utf8'));
      if(owner.token!==token)throw new Error('Resource lock ownership changed');
      await fs.rm(dir,{recursive:true});
    }
    releases.delete(release);
   })();return releasing;
  }
  try {
    for(const resource of [...new Set(resources)].sort()) {
      const dir=path.join(root,createHash('sha256').update(resource).digest('hex'));
      try {await fs.mkdir(dir,{mode:0o700});}
      catch(e:any){if(e.code==='EEXIST')throw new Error(`Evaluation resource is locked: ${resource}. Inspect ${dir}/owner.json; remove a stale lock only after confirming its process has stopped.`);throw e;}
      const token=randomUUID();
      await fs.writeFile(path.join(dir,'owner.json'),JSON.stringify({pid:process.pid,host:os.hostname(),resource,token,startedAt:new Date().toISOString()}));
      held.push({dir,token});
    }
  }catch(e){await release();throw e;}
  releases.add(release);return release;
}
