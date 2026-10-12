import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function bootstrap(root=process.cwd()) {
  const read = name => readFileSync(join(root,name));
  const save = (name,bytes) => {mkdirSync(resolve(root,name,'..'),{recursive:true});writeFileSync(join(root,name),bytes);};
  // These are dated historical observations, NOT downloads performed by this run.
  const historical=join(root,'data/cloud-bootstrap/history-manifest.json');
  if(existsSync(historical)) {
    const manifest=JSON.parse(readFileSync(historical,'utf8'));
    for(const entry of manifest.files) {
      if(!/^\d{4}-\d{2}-\d{2}(?:--[0-9]+--[a-f0-9]{12})?\.json$/.test(entry.name))throw Error('Unsafe history filename');
      const bytes=gunzipSync(read(`data/cloud-bootstrap/${entry.name}.gz`),{maxOutputLength:20*1024*1024});
      if(sha256(bytes)!==entry.sha256)throw Error('Historical evidence digest mismatch: '+entry.name);
      const record=JSON.parse(bytes.toString('utf8'));
      if(record.snapshot_date!==entry.name.slice(0,10))throw Error('Historical date mismatch');
      const target=join(root,'data/snapshots',entry.name);
      if(existsSync(target)&&sha256(readFileSync(target))!==entry.sha256)throw Error('Refusing to replace immutable historical evidence');
      if(!existsSync(target))save('data/snapshots/'+entry.name,bytes);
    }
  }
  const bytes=read('public/data/full_snapshot.json'),snapshot=JSON.parse(bytes.toString('utf8'));
  if(snapshot.excel_dependency!==false||!snapshot.generated_at||!snapshot.sources?.length)throw Error('Invalid published baseline');
  const stamp=snapshot.generated_at.replace(/[^0-9]/g,''),digest=sha256(bytes);
  const immutable=`data/snapshots/${snapshot.snapshot_date}--${stamp}--${digest.slice(0,12)}.json`;
  if(existsSync(join(root,immutable))&&sha256(read(immutable))!==digest)throw Error('Immutable baseline collision');
  if(!existsSync(join(root,immutable)))save(immutable,bytes);
  save('data/snapshots/latest.json',bytes);
  save('data/processed/full_snapshot.json',bytes);
  save('data/raw_manifest.json',JSON.stringify({generated_at:snapshot.generated_at,documents:snapshot.sources},null,2)+'\n');
  for(const name of ['dashboard','pipeline_watch','pipeline_analytics','link_audit'])save(`data/processed/${name}.json`,read(`public/data/${name}.json`));
  // Replace the original user workbook seed with already-public verified mappings.
  // The collector still checks every identity against newly downloaded official directories.
  if(!existsSync(join(root,'data/reference/excel_seed.json')))save('data/reference/excel_seed.json',JSON.stringify({
    role:'Previously published official A/H identity mappings; not a user workbook',
    generated_at:snapshot.generated_at,
    listed_mappings:snapshot.a_to_h_listed.map(r=>({hk_code:r.hk_code,a_code:r.a_code,company_name:r.company_name,exchange_hint:r.a_exchange==='SSE'?'SH':'SZ'})),
    pipeline_candidates:[]
  },null,2)+'\n');
  return {snapshot_date:snapshot.snapshot_date,generated_at:snapshot.generated_at,sha256:digest};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log('Restored historical baseline (not refreshed):',bootstrap());
