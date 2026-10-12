import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
const origin=process.env.SMOKE_ORIGIN||'http://localhost:3000';
const routes=['/','/versions/v22','/versions/v23','/favicon.svg','/og.png'];
for(const dir of ['data','versions/v22/data','versions/v23/data']) {
  for(const name of await readdir(join('public',dir))) {
    const path=join('public',dir,name),payload=await readFile(path);
    if(!payload.length)throw Error(`Empty download ${path}`);
    if(name.endsWith('.json'))JSON.parse(payload.toString('utf8'));
    routes.push('/'+dir+'/'+name);
  }
}
for(const path of routes){
  const response=await fetch(origin+path);
  if(response.status!==200)throw Error(`${path}: HTTP ${response.status}`);
  const bytes=new Uint8Array(await response.arrayBuffer());if(!bytes.length)throw Error(`${path}: empty response`);
  if(path.endsWith('.json'))JSON.parse(new TextDecoder().decode(bytes));
}
for(const dataset of ['ipo','applications','pipeline','watch','ah-listed']){
  const r=await fetch(`${origin}/api/export?dataset=${dataset}&rows=0,1`);
  if(!r.ok||!r.headers.get('content-disposition')?.includes('attachment'))throw Error(`${dataset}: not a downloadable attachment`);
  if((await r.text()).split('\r\n').length!==3)throw Error(`${dataset}: wrong selected row count`);
}
console.log(`PASS: ${routes.length} pages/assets/downloads and 5 filtered export endpoints; current and both historical versions.`);
