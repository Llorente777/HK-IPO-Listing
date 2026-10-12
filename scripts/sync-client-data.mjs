import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Public downloads must remain assets, not Vite module imports. Keep the
// generated client inputs byte-identical to those downloads and validate them.
mkdirSync('data/processed', {recursive:true});
for (const name of ['pipeline_watch.json','pipeline_analytics.json','link_audit.json']) {
  const payload=readFileSync('public/data/'+name);
  JSON.parse(payload.toString('utf8'));
  writeFileSync('data/processed/'+name,payload);
}
