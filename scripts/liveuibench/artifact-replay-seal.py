#!/usr/bin/env python3
"""Seal original delivered apps only. No models, provider config or world copying."""
import argparse,pathlib,json,hashlib,sqlite3,shutil,os

def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def write(p,v):p.parent.mkdir(parents=True,exist_ok=True,mode=0o700);p.write_text(json.dumps(v,indent=2)+'\n');p.chmod(0o600)
def seal(case_root,dataset,account_root,source_manifest,out):
 case_root=pathlib.Path(case_root).resolve();out=pathlib.Path(out).resolve()
 if not json.loads((case_root/'cleanup.json').read_text()).get('complete'):raise ValueError('Source case must have completed owned cleanup before sealing')
 source_identity=json.loads(pathlib.Path(source_manifest).read_text());worker_identity=json.loads((case_root/'worker-plan.json').read_text())
 if worker_identity.get('sourceManifestSha256')!=sha(source_manifest):raise ValueError('Source case was not generated from the supplied frozen source manifest')
 if source_identity.get('files',{}).get('bench/benchmarks/liveuibench.json')!=sha(dataset):raise ValueError('Replay dataset differs from the original frozen generation/evaluation dataset')
 raw=json.loads(pathlib.Path(dataset).read_text());cases=raw if isinstance(raw,list) else raw['cases'];case=next(c for c in cases if c['id']==case_root.name)
 groups=case.get('episodeGroups') or [{'intentionIndex':0,'episodes':case.get('episodes',[])}];out.mkdir(parents=True,exist_ok=False,mode=0o700);manifest={'schema':'liveuibench-artifact-replay-v1','caseId':case['id'],'generationSourceSha256':sha(source_manifest),'originalSourceCommits':json.loads(pathlib.Path(source_manifest).read_text()).get('commits'),'groups':[]}
 db=sqlite3.connect('file:'+str(case_root/'runtime.db')+'?mode=ro',uri=True)
 try:
  for i,group in enumerate(groups):
   index=group['intentionIndex'];prompt=case['intentions'][index]['intention'];entry={'groupIndex':i,'intentionIndex':index,'promptSha256':hashlib.sha256(prompt.encode()).hexdigest(),'available':False};manifest['groups'].append(entry)
   try:
    generation=case_root/'reports'/case['id']/('group-'+str(i+1))/'generation.json';generated=json.loads(generation.read_text())
    if generated.get('type')!='app_created' or generated.get('execution',{}).get('harness')!='dsh':raise ValueError('Original group has no completed DSH app_created delivery')
    app_id=generated['appPackage']['manifest']['appId']
    if not app_id.startswith('dsh_'):raise ValueError('Original app ID is not a DSH artifact')
    source_state=None;metadata=None;owner=None
    for state in case_root.glob('dsh-evidence/*/state.json'):
     candidate=json.loads(state.read_text());found=next((a for a in candidate.get('apps',[]) if 'dsh_'+a['id']==app_id),None)
     if found:source_state=state;metadata=found;break
    if not metadata or metadata.get('revision')!=1:raise ValueError('Original immutable initial-revision metadata unavailable')
    account=pathlib.Path(account_root)/'accounts'/source_state.parent.name;html=account/'apps'/metadata['id']/'index.html';work=account/'runs'/metadata['lastJobId']/'work/index.html'
    if html.is_symlink() or work.is_symlink() or sha(html)!=sha(work):raise ValueError('Delivered HTML differs from original generation job output')
    binding=db.execute('SELECT owner,plan_json,request_text,revision FROM complete_service_bindings WHERE app_id=? AND generation_job_id=? AND (revision IS NULL OR revision=?)',(app_id,metadata['lastJobId'],metadata['revision'])).fetchall()
    if len(binding)!=1:raise ValueError('Original generation-scoped service binding unavailable or ambiguous')
    folder=out/('group-'+str(i+1));folder.mkdir(mode=0o700);shutil.copy2(html,folder/'index.html');shutil.copy2(generation,folder/'generation.json');write(folder/'metadata.json',metadata);write(folder/'service-binding.json',{'plan':json.loads(binding[0][1]),'request':binding[0][2],'originalBindingRevision':binding[0][3]})
    entry.update(available=True,originalAppId=app_id,originalGenerationJobId=metadata['lastJobId'],execution=generated['execution'],originalStateSha256=sha(source_state))
    for key,name in [('html','index.html'),('generation','generation.json'),('metadata','metadata.json'),('serviceBinding','service-binding.json')]:entry[key]=str((folder/name).relative_to(out));entry[key+'Sha256']=sha(folder/name)
   except (FileNotFoundError,ValueError,KeyError,StopIteration) as error:entry['reason']=str(error) if not isinstance(error,FileNotFoundError) else 'Original delivered group artifact is unavailable'
 finally:db.close()
 write(out/'manifest.json',manifest);return {'caseId':case['id'],'groups':len(groups),'availableGroups':sum(g['available'] for g in manifest['groups']),'manifestSha256':sha(out/'manifest.json')}
if __name__=='__main__':
 os.umask(0o077);p=argparse.ArgumentParser();p.add_argument('--case-root',required=True);p.add_argument('--dataset',required=True);p.add_argument('--account-root',required=True);p.add_argument('--generation-source-manifest',required=True);p.add_argument('--out',required=True);a=p.parse_args();print(json.dumps(seal(a.case_root,a.dataset,a.account_root,a.generation_source_manifest,a.out)))
