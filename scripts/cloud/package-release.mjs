import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {sha256} from './bootstrap.mjs';

const names=['dashboard.json','full_snapshot.json','pipeline_watch.json','pipeline_analytics.json','link_audit.json',
  'listed_ipos.csv','active_applications.csv','research_active_applications.csv','excluded_non_ipo_listings.csv',
  'a_to_h.csv','a_to_h_exclusions.csv','pipeline_watch.csv','a_to_h_watch.csv','pipeline_analytics.csv'];
const files=names.map(name=>{const bytes=readFileSync('public/data/'+name);return {name,bytes:bytes.length,sha256:sha256(bytes)};});
const id=sha256(Buffer.from(JSON.stringify(files)));
const target=join('outputs/cloud-release',id);mkdirSync(target,{recursive:true});
for(const file of files)copyFileSync('public/data/'+file.name,join(target,file.name));
const snapshot=JSON.parse(readFileSync('public/data/full_snapshot.json','utf8'));
const manifest={schema_version:1,id,created_at:new Date().toISOString(),official_snapshot_date:snapshot.snapshot_date,
  data_generated_at:snapshot.generated_at,repository:process.env.GITHUB_REPOSITORY||null,
  source_commit:process.env.GITHUB_SHA||null,run_id:process.env.GITHUB_RUN_ID||null,
  refreshed_official:process.env.CLOUD_REFRESH_OFFICIAL==='true',
  publication_status:'validated_candidate_not_published',files};
writeFileSync(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({id,files:files.length,publication_status:manifest.publication_status}));
