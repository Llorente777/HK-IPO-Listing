export function exportUrl(dataset:string,indices:number[],params:Record<string,string|number>={}) {
  const q=new URLSearchParams({dataset,rows:indices.join(','),...Object.fromEntries(Object.entries(params).map(([k,v])=>[k,String(v)]))});
  return '/api/export?'+q.toString();
}
