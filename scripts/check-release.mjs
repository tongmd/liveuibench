import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyFrontendSnapshot } from './prepare-frontend.mjs';

// Report location and rule only; never print a matched credential or source line.
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(file=>file && existsSync(file)))];
const findings = [];
// The requested public/dev evaluation corpus is deliberately distributable.
// Keep other benchmark trees excluded, and verify this one against provenance.
const allowedBench = new Set(['docs/benchmarks/README.md', 'benchmarks/README.md', 'benchmarks/provenance.json', 'benchmarks/smoke.json', 'benchmarks/liveuibench.json']);
try {
  const provenance = JSON.parse(await readFile('benchmarks/provenance.json', 'utf8'));
  const datasetBytes = await readFile('benchmarks/liveuibench.json');
  const dataset = JSON.parse(datasetBytes);
  const cases = Array.isArray(dataset) ? dataset : dataset.cases;
  if (cases.length !== provenance.caseCount || cases.some(item => !['dev', 'public_test'].includes(item.split))
    || createHash('sha256').update(datasetBytes).digest('hex') !== provenance.datasetSha256) throw Error('Dataset provenance mismatch');
  const ids = new Set(cases.map(item => item.id));
  for (const fixture of provenance.fixtures) {
    if (!ids.has(fixture.id) || !/^[a-zA-Z0-9_.-]+$/.test(fixture.id)) throw Error('Unexpected fixture');
    const file = `benchmarks/fixtures/${fixture.id}.json`;
    if (createHash('sha256').update(await readFile(file)).digest('hex') !== fixture.sha256) throw Error('Fixture provenance mismatch');
    allowedBench.add(file);
  }
} catch { findings.push({ file: 'benchmarks/provenance.json', line: 1, rule: 'benchmark-provenance' }); }
const paperAssets = new Set(['paper/liveuibench-arxiv-v1.pdf','paper/liveuibench-arxiv-v1-source.tar.gz','paper/agent-as-app-teaser.png']);
try {
  const provenance=JSON.parse(await readFile('paper/provenance.json','utf8'));
  if(provenance.arxiv_id!=='2610.27977'||provenance.arxiv_version!=='v1'||provenance.assets.length!==3)throw Error('Unexpected publication');
  for(const asset of provenance.assets){
    const file='paper/'+asset.path;
    if(!paperAssets.has(file))throw Error('Unexpected paper asset');
    const bytes=await readFile(file);
    if(bytes.length!==asset.bytes||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('Paper asset hash mismatch');
  }
  const citation=await readFile('citation.bib','utf8');
  if(!citation.includes('2610.27977')||!citation.replace(/[{}]/g,'').includes(provenance.title)||provenance.authors.some(name=>{const parts=name.split(' ');return !citation.includes(parts.slice(-1)[0]+', '+parts.slice(0,-1).join(' '));}))throw Error('Citation metadata mismatch');
}catch {findings.push({file:'paper/provenance.json',line:1,rule:'paper-provenance'});}
const forbidden = /(^|\/)(?:\.env(?:\.[^/]*)?|node_modules|\.test-runs|generated-apps(?:-[^/]*)?|data|artifacts|papers|benchmarks|\.claude|\.aris|\.agents)(?:\/|$)|\.(?:db|db-wal|db-shm|pem|key)$/;
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['cloud-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['model-api-key', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}\b/],
  ['credential-in-url', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['personal-home-path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ['private-remote-user', /\b(?:ubuntu|UBUNTU|root)@(?:\d{1,3}\.){3}\d{1,3}\b/],
];
for (const file of files) {
  if (file !== '.env.example' && !allowedBench.has(file) && forbidden.test(file)) findings.push({ file, line: 1, rule: 'prohibited-file' });
  const info = await stat(file);
  if (!info.isFile()) continue;
  if (info.size > 10 * 1024 * 1024) findings.push({ file, line: 1, rule: 'oversized-source' });
  const bytes = await readFile(file);
  if (paperAssets.has(file)) continue; // Exact official asset hashes are verified above.
  if (bytes.includes(0)) continue;
  const lines = bytes.toString('utf8').split('\n');
  for (let index = 0; index < lines.length; index++) {
    for (const [rule, pattern] of rules) {
      if (pattern.test(lines[index])) findings.push({ file, line: index + 1, rule });
    }
  }
}
try {
  await verifyFrontendSnapshot();
} catch {
  findings.push({ file: 'frontend/snapshot/manifest.json', line: 1, rule: 'frontend-integrity' });
}
if (findings.length) {
  for (const { file, line, rule } of findings) console.error(`${file}:${line} ${rule}`);
  process.exitCode = 1;
} else {
  console.log(`Release baseline passed: ${files.length} files; no prohibited files or common credential/private-path patterns; all frontend resource hashes verified.`);
}
