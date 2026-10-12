import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {bootstrap,sha256} from '../scripts/cloud/bootstrap.mjs';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'hkipo-cloud-test-'));
  mkdirSync(join(root,'public/data'),{recursive:true});
  const snapshot={snapshot_date:'2026-10-12',generated_at:'2026-10-12T11:07:25+08:00',excel_dependency:false,
    sources:[{source:'HKEXnews',fetched_at:'2026-10-12T10:00:00+08:00'}],a_to_h_listed:[{company_name:'测试公司',hk_code:'01234',a_code:'600001',a_exchange:'SSE'}]};
  for(const name of ['full_snapshot','dashboard','pipeline_watch','pipeline_analytics','link_audit'])writeFileSync(join(root,'public/data',name+'.json'),JSON.stringify(snapshot));
  return {root,snapshot,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('cloud bootstrap preserves original observation dates and exact baseline bytes',()=>{
  const f=fixture();try {
    const result=bootstrap(f.root);
    assert.equal(result.generated_at,f.snapshot.generated_at);
    assert.deepEqual(readFileSync(join(f.root,'data/snapshots/latest.json')),readFileSync(join(f.root,'public/data/full_snapshot.json')));
    const manifest=JSON.parse(readFileSync(join(f.root,'data/raw_manifest.json')));
    assert.equal(manifest.documents[0].fetched_at,f.snapshot.sources[0].fetched_at);
    const seed=JSON.parse(readFileSync(join(f.root,'data/reference/excel_seed.json')));
    assert.equal(seed.listed_mappings[0].a_code,'600001');assert.equal(seed.source_file_name,undefined);
    assert.deepEqual(bootstrap(f.root),result);
  }finally{f.cleanup();}
});
test('historical archives are hash verified and never silently overwritten',()=>{
  const f=fixture();try {
    const name='2026-10-07.json',payload=Buffer.from(JSON.stringify({...f.snapshot,snapshot_date:'2026-10-07'}));
    mkdirSync(join(f.root,'data/cloud-bootstrap'),{recursive:true});
    writeFileSync(join(f.root,'data/cloud-bootstrap',name+'.gz'),gzipSync(payload));
    writeFileSync(join(f.root,'data/cloud-bootstrap/history-manifest.json'),JSON.stringify({files:[{name,sha256:sha256(payload)}]}));
    bootstrap(f.root);assert.deepEqual(readFileSync(join(f.root,'data/snapshots',name)),payload);
    writeFileSync(join(f.root,'data/snapshots',name),'changed');
    assert.throws(()=>bootstrap(f.root),/Refusing to replace/);
  }finally{f.cleanup();}
});
test('rejects path traversal before reading archive data',()=>{
  const f=fixture();try {
    mkdirSync(join(f.root,'data/cloud-bootstrap'),{recursive:true});
    writeFileSync(join(f.root,'data/cloud-bootstrap/history-manifest.json'),JSON.stringify({files:[{name:'../../other.json',sha256:'x'}]}));
    assert.throws(()=>bootstrap(f.root),/Unsafe history filename/);
    assert.equal(existsSync(join(f.root,'data/snapshots/latest.json')),false);
  }finally{f.cleanup();}
});
