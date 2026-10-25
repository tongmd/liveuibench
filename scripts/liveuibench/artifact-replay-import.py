"""Offline artifact sealing/import. Never generates HTML or copies source world/auth."""
import pathlib,json,hashlib,uuid,sqlite3,os,re

def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def atom(p,v):
 p=pathlib.Path(p);p.parent.mkdir(parents=True,exist_ok=True,mode=0o700);tmp=p.with_name(p.name+'.tmp');tmp.write_text(json.dumps(v,indent=2)+'\n');tmp.chmod(0o600);tmp.replace(p)
def prompt_sha(text):return hashlib.sha256(text.encode()).hexdigest()
def verify(root,expected):
 root=pathlib.Path(root).resolve();manifest=root/'manifest.json'
 if sha(manifest)!=expected:raise ValueError('Artifact manifest SHA changed')
 v=json.loads(manifest.read_text())
 if v.get('schema')!='liveuibench-artifact-replay-v1':raise ValueError('Unsupported replay schema')
 for g in v['groups']:
  if not g.get('available'):continue
  for key,hkey in [('html','htmlSha256'),('generation','generationSha256'),('metadata','metadataSha256'),('serviceBinding','serviceBindingSha256')]:
   p=pathlib.Path(g[key]);f=root/p
   if p.is_absolute() or '..' in p.parts or not f.resolve().is_relative_to(root) or f.is_symlink() or sha(f)!=g[hkey]:raise ValueError('Artifact changed: '+key)
 return v

def import_case(root,expected,case_id,owner,prefix,account_root,runtime_db,receipt_dir):
 root=pathlib.Path(root).resolve();v=verify(root,expected)
 if v['caseId']!=case_id:raise ValueError('Replay case mismatch')
 if not isinstance(owner,str) or not owner or not isinstance(prefix,str) or len(prefix)>100 or not re.fullmatch(r'artifact-replay-[A-Za-z0-9][A-Za-z0-9_-]{0,79}-',prefix) or len(prefix)+len(owner)>200:raise ValueError('Only bounded artifact-replay namespaces and combined owner identity <=200 are allowed')
 account_root=pathlib.Path(account_root).resolve();directory=account_root/'accounts'/hashlib.sha256((prefix+owner).encode()).hexdigest()
 # Exclusive account creation; never overwrite a real or previously loaded account.
 directory.mkdir(parents=True,exist_ok=False,mode=0o700);apps=[];mapping=[]
 db=sqlite3.connect(runtime_db)
 try:
  db.execute('BEGIN IMMEDIATE')
  for g in v['groups']:
   if not g.get('available'):
    mapping.append({'groupIndex':g['groupIndex'],'intentionIndex':g['intentionIndex'],'available':False,'reason':g.get('reason','No original delivered artifact'),'promptSha256':g['promptSha256']});continue
   metadata=json.loads((root/g['metadata']).read_text());binding=json.loads((root/g['serviceBinding']).read_text());new_id=str(uuid.uuid4());generation_id='artifact_replay_'+uuid.uuid4().hex
   app={**metadata,'id':new_id,'lastJobId':generation_id,'revision':1,'example':False};apps.append(app)
   target=directory/'apps'/new_id;target.mkdir(parents=True,mode=0o700)
   html=(root/g['html']).read_bytes();(target/'index.html').write_bytes(html);(target/'index.html').chmod(0o600);atom(target/'store.json',{})
   db.execute('INSERT INTO complete_service_bindings(owner,app_id,generation_job_id,revision,plan_json,request_text) VALUES (?,?,?,?,?,?)',(owner,'dsh_'+new_id,generation_id,1,json.dumps(binding['plan']),binding['request']))
   mapping.append({'groupIndex':g['groupIndex'],'intentionIndex':g['intentionIndex'],'available':True,'appId':'dsh_'+new_id,'newGenerationJobId':generation_id,'originalAppId':g['originalAppId'],'originalGenerationJobId':g['originalGenerationJobId'],'htmlSha256':g['htmlSha256'],'generationSha256':g['generationSha256'],'generationSourceSha256':v['generationSourceSha256'],'promptSha256':g['promptSha256'],'execution':g['execution'],'reusedArtifact':True,'generationModelCalls':0})
  atom(directory/'state.json',{'apps':apps,'jobs':[],'memory':{'manual':'','entries':[]},'memoryFormatVersion':1,'seedVersion':1});db.commit()
 except Exception:db.rollback();raise
 finally:db.close()
 receipt={'caseId':case_id,'owner':owner,'ownerPrefix':prefix,'accountRoot':str(account_root),'accountHash':directory.name,'groups':mapping,'reusedArtifact':True,'generationModelCalls':0,'sourceArtifactManifestSha256':expected,'initialStore':'fresh empty object; original source store/world/auth never copied'};atom(pathlib.Path(receipt_dir)/(hashlib.sha256(owner.encode()).hexdigest()+'.json'),receipt);return receipt

def load_or_import(config,owner):
 receipt_file=pathlib.Path(config['receiptDir'])/(hashlib.sha256(owner.encode()).hexdigest()+'.json')
 if receipt_file.exists():
  value=json.loads(receipt_file.read_text())
  if value.get('owner')!=owner or value.get('ownerPrefix')!=config['ownerPrefix'] or value.get('accountRoot')!=str(pathlib.Path(config['accountRoot']).resolve()) or value.get('sourceArtifactManifestSha256')!=config['manifestSha256'] or value.get('caseId')!=config['caseId']:raise ValueError('Existing replay receipt identity mismatch')
  verify(config['manifestRoot'],config['manifestSha256']);return value
 return import_case(config['manifestRoot'],config['manifestSha256'],config['caseId'],owner,config['ownerPrefix'],config['accountRoot'],config['runtimeDb'],config['receiptDir'])
if __name__=='__main__':
 import sys
 os.umask(0o077)
 if len(sys.argv) not in [3,6]:raise SystemExit('Pass a replay configuration JSON path and a scoped new owner')
 try:
  config=json.loads(pathlib.Path(sys.argv[1]).read_text())
  if len(sys.argv)==6:
   manifest=verify(config['manifestRoot'],config['manifestSha256']);group=next((g for g in manifest['groups'] if g['groupIndex']==int(sys.argv[3])),None)
   if not group or group['intentionIndex']!=int(sys.argv[4]) or group['promptSha256']!=sys.argv[5]:raise ValueError('Replay group/intention/prompt SHA mismatch')
   ledger=pathlib.Path(config['receiptDir'])/(hashlib.sha256(sys.argv[2].encode()).hexdigest()+'.consumption.json');consumed=json.loads(ledger.read_text()) if ledger.exists() else []
   if int(sys.argv[3])!=len(consumed):raise ValueError('Replay group requests must follow the original ordered groups exactly once')
  receipt=load_or_import(config,sys.argv[2])
  if len(sys.argv)==6:
   group_index=int(sys.argv[3]);intention=int(sys.argv[4]);digest=sys.argv[5];ledger=pathlib.Path(config['receiptDir'])/(hashlib.sha256(sys.argv[2].encode()).hexdigest()+'.consumption.json');consumed=json.loads(ledger.read_text()) if ledger.exists() else []
   if group_index!=len(consumed):raise ValueError('Replay group requests must follow the original ordered groups exactly once')
   group=next((x for x in receipt['groups'] if x['groupIndex']==group_index),None)
   if not group or group['intentionIndex']!=intention or group['promptSha256']!=digest:raise ValueError('Replay group/intention/prompt SHA mismatch')
   consumed.append({'groupIndex':group_index,'intentionIndex':intention,'promptSha256':digest});atom(ledger,consumed)
  print(json.dumps(receipt))
 except Exception as e:raise SystemExit(type(e).__name__+': '+str(e))
