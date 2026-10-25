import {readFile,writeFile} from 'node:fs/promises';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
import {validateCase,runCase,type Adapter,type Case} from './protocol.js';
const args=process.argv.slice(2);const validate=args.includes('--validate');const dataset=args[args.indexOf('--dataset')+1]??'';
if(!args.includes('--dataset')||!dataset)throw new Error('Usage: --dataset file.json [--validate | --adapter module --out report.json]');
const raw=JSON.parse(await readFile(resolve(dataset),'utf8'));const cases:Case[]=Array.isArray(raw)?raw:raw.cases;
if(!Array.isArray(cases)||!cases.length)throw new Error('Expected nonempty cases array');const ids=new Set();for(const c of cases){validateCase(c);if(ids.has(c.id))throw new Error('Duplicate case id');ids.add(c.id)}
if(validate){console.log(JSON.stringify({validated:true,cases:cases.length,executed:false,realModelCalls:0}));}
else{const adapterPath=args[args.indexOf('--adapter')+1],out=args[args.indexOf('--out')+1];if(!args.includes('--adapter')||!args.includes('--out')||!adapterPath||!out)throw new Error('No built-in real adapter: explicit --adapter and --out required');const module=await import(pathToFileURL(resolve(adapterPath)).href);if(typeof module.createAdapter!=='function')throw new Error('Adapter must export createAdapter()');const results=[];for(const c of cases){const adapter:Adapter=await module.createAdapter();results.push(await runCase(c,adapter))}await writeFile(resolve(out),JSON.stringify({protocol:'liveuibench.longitudinal.v1',comparable:false,results},null,2));}
