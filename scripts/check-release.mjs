import {execFileSync} from 'node:child_process';import fs from 'node:fs';
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);let n=0;
for(const f of files){if(!fs.existsSync(f)||!fs.statSync(f).isFile())continue;const b=fs.readFileSync(f);if(b.includes(0))continue;const s=b.toString();for(const pattern of [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9]{30,}/,/\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/,/https?:\/\/[^\s/:]+:[^\s/@]+@/,/\/(?:Users|home)\/[A-Za-z0-9_.-]+\//])if(pattern.test(s))throw Error('Potential credential or personal path in '+f);n++;}console.log('Source credential/path scan passed: '+n+' text files.');

const {createHash}=await import('node:crypto');
const provenance=JSON.parse(fs.readFileSync('benchmarks/provenance.json','utf8'));
const dataset=fs.readFileSync('benchmarks/liveuibench.json');
const cases=JSON.parse(dataset);const rows=Array.isArray(cases)?cases:cases.cases;
const hash=b=>createHash('sha256').update(b).digest('hex');
if(rows.length!==provenance.caseCount||hash(dataset)!==provenance.datasetSha256||rows.some(c=>!['dev','public_test'].includes(c.split)))throw Error('Dataset provenance mismatch');
for(const fixture of provenance.fixtures)if(hash(fs.readFileSync('benchmarks/fixtures/'+fixture.id+'.json'))!==fixture.sha256)throw Error('Fixture provenance mismatch: '+fixture.id);
console.log('Published dataset and '+provenance.fixtures.length+' fixture hashes verified.');

const longitudinal=JSON.parse(fs.readFileSync('benchmarks/longitudinal.json','utf8'));
const longitudinalProvenance=JSON.parse(fs.readFileSync('benchmarks/longitudinal-provenance.json','utf8'));
if(hash(fs.readFileSync('benchmarks/longitudinal.json'))!==longitudinalProvenance.datasetSha256
 || (provenance.authoredExpansion?.originalDatasetSha256 ?? hash(dataset))!==longitudinalProvenance.originalDatasetSha256
 || longitudinal.caseCount!==longitudinal.cases.length
 || longitudinal.cases.length!==longitudinalProvenance.statistics.cases
 || longitudinal.cases.some(c=>c.source?.kind!=='authored'))throw Error('Longitudinal provenance mismatch');
console.log('Authored longitudinal dataset and original dataset hash verified.');

const expanded=JSON.parse(fs.readFileSync('benchmarks/liveuibench-expanded.json','utf8'));
const expandedProvenance=JSON.parse(fs.readFileSync('benchmarks/liveuibench-expanded.provenance.json','utf8'));
if(hash(dataset)!==expandedProvenance.sourceFileSha256||hash(fs.readFileSync('benchmarks/liveuibench-expanded.json'))!==expandedProvenance.expandedFileSha256||expanded.cases.length!==rows.length)throw Error('Expanded dataset provenance mismatch');
for(let i=0;i<rows.length;i++){const {extensionIds,longitudinalExtensions,...original}=expanded.cases[i];if(JSON.stringify(original)!==JSON.stringify(rows[i])||longitudinalExtensions.length!==rows[i].intentions.length*2)throw Error('Expanded source case changed or missing coverage');}
console.log('Expanded original cases and per-application coverage verified.');

if(provenance.authoredExpansion){
 const additions=JSON.parse(fs.readFileSync('benchmarks/authored-500-provenance.json','utf8'));
 const prefix=rows.slice(0,additions.originalCaseCount);
 if(prefix.length!==319||rows.length!==500||additions.addedCaseCount!==181)throw Error('Authored expansion count mismatch');
 for(const c of prefix)if(hash(Buffer.from(JSON.stringify(c)))!==additions.originalCaseSha256[c.id])throw Error('Original case changed: '+c.id);
 if(rows.slice(319).some(c=>c.split!=='dev'||c.fixturesRef!==false)||JSON.stringify(rows.slice(319).map(c=>c.id))!==JSON.stringify(additions.addedCaseIds))throw Error('Authored expansion provenance mismatch');
 console.log('Original 319 objects unchanged; 181 authored development additions verified.');
}
