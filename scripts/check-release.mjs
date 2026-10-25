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
 || hash(dataset)!==longitudinalProvenance.originalDatasetSha256
 || longitudinal.caseCount!==longitudinal.cases.length
 || longitudinal.cases.length!==longitudinalProvenance.statistics.cases
 || longitudinal.cases.some(c=>c.source?.kind!=='authored'))throw Error('Longitudinal provenance mismatch');
console.log('Authored longitudinal dataset and original dataset hash verified.');
