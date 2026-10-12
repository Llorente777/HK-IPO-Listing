import {existsSync,readdirSync,readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join,resolve,relative,dirname} from 'node:path';
import {gzipSync} from 'node:zlib';
import {sha256} from './bootstrap.mjs';

const root=process.cwd(),target=resolve(root,'outputs/github-cloud-migration/repository');
mkdirSync(target,{recursive:true});
// Export a clean tree, never the Sites Git history, credentials, Excel uploads or caches.
const roots=['app','lib','build','db','drizzle','scripts','tests','public','worker'];
const files=['.github/workflows/weekly-update.yml','.gitignore','.openai/hosting.json','README.md',
  'package.json','pnpm-lock.yaml','requirements.txt','next-env.d.ts','next.config.ts','tsconfig.json',
  'vite.config.ts','vitest.config.ts','drizzle.config.ts','postcss.config.mjs','eslint.config.mjs',
  'docs/METHODOLOGY.md','docs/SOURCES.md','docs/CLOUD_UPDATE.md','data/reference/pipeline_intelligence.json',
  ...['dashboard','pipeline_watch','pipeline_analytics','link_audit'].map(n=>`data/processed/${n}.json`)];
function walk(dir) {for(const e of readdirSync(join(root,dir),{withFileTypes:true})) {
  if(e.isSymbolicLink())throw Error('Refusing symlink '+e.name);
  if(['__pycache__','node_modules'].includes(e.name))continue;
  const name=dir+'/'+e.name;if(e.isDirectory())walk(name);else if(!/\.(pyc|xlsx?|pem|key|tgz|zip)$/i.test(e.name))files.push(name);
}}
for(const dir of roots)walk(dir);
const inventory=[];
for(const name of [...new Set(files)].sort()) {
  if(!existsSync(join(root,name)))throw Error('Missing required export: '+name);
  const bytes=readFileSync(join(root,name));
  if(/\.(?:json|tsx?|mjs|py|ya?ml|md|csv)$/.test(name)) {
    const s=bytes.toString('utf8');
    if(/(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----)/.test(s))throw Error('Possible secret; export blocked: '+name);
  }
  const dest=join(target,name);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(root,name),dest);
  inventory.push({name,bytes:bytes.length,sha256:sha256(bytes)});
}
// Preserve earlier public evidence needed for sponsor recovery and delisted indexes.
// Failed 2026-09-28 intermediate snapshots are deliberately excluded.
const history=[];
for(const name of readdirSync(join(root,'data/snapshots')).sort()) {
  if(!/^\d{4}-\d{2}-\d{2}(?:--[0-9]+--[a-f0-9]{12})?\.json$/.test(name)||name.startsWith('2026-09-28'))continue;
  const bytes=readFileSync(join(root,'data/snapshots',name)),record=JSON.parse(bytes.toString('utf8'));
  if(record.snapshot_date!==name.slice(0,10)||!record.generated_at||!record.sources?.length)throw Error('Invalid archived evidence '+name);
  const path=join(target,'data/cloud-bootstrap',name+'.gz');mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,gzipSync(bytes,{level:9}));history.push({name,sha256:sha256(bytes),generated_at:record.generated_at});
}
writeFileSync(join(target,'data/cloud-bootstrap/history-manifest.json'),JSON.stringify({role:'Historical observations, not fresh downloads or a publication claim',files:history},null,2)+'\n');
writeFileSync(join(root,'outputs/github-cloud-migration/export-inventory.json'),JSON.stringify({repository:'Llorente777/HK-IPO-Listing',files:inventory,history},null,2)+'\n');
console.log(JSON.stringify({target:relative(root,target),files:inventory.length,historical_observations:history.length}));
