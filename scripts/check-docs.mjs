import fs from 'node:fs/promises';import path from 'node:path';
const files=['README.md'];const scripts=JSON.parse(await fs.readFile('package.json','utf8')).scripts;
for(const f of files){const s=await fs.readFile(f,'utf8');for(const m of s.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)){const link=m[1].split('#')[0];if(!link||/^[a-z]+:/i.test(link))continue;await fs.access(path.resolve(path.dirname(f),link));}for(const m of s.matchAll(/npm run ([a-z][a-z\d:_-]*)/g))if(!scripts[m[1]])throw Error('Unknown npm script: '+m[1]);}console.log('README links and npm commands verified.');
