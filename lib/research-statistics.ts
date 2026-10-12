export type IpoRecord={company_name:string;listing_date:string|null;total_proceeds_hkd:number;market:string;hk_code:string};
export function ipoStatistics(rows:readonly IpoRecord[]) {
  const values=rows.map(r=>r.total_proceeds_hkd).sort((a,b)=>a-b),total=values.reduce((s,v)=>s+v,0),middle=Math.floor(values.length/2);
  const monthly=new Map<string,{month:string;count:number;proceeds:number}>();
  for(const r of rows){if(!r.listing_date)continue;const month=r.listing_date.slice(0,7),item=monthly.get(month)||{month,count:0,proceeds:0};item.count++;item.proceeds+=r.total_proceeds_hkd;monthly.set(month,item);}
  const bands=[{label:'10亿以下',min:0,max:1e9},{label:'10–50亿',min:1e9,max:5e9},{label:'50–100亿',min:5e9,max:1e10},{label:'100亿以上',min:1e10,max:Infinity}].map(b=>({...b,count:rows.filter(r=>r.total_proceeds_hkd>=b.min&&r.total_proceeds_hkd<b.max).length,proceeds:rows.filter(r=>r.total_proceeds_hkd>=b.min&&r.total_proceeds_hkd<b.max).reduce((s,r)=>s+r.total_proceeds_hkd,0)}));
  return {count:rows.length,total,average:rows.length?total/rows.length:null,median:values.length?(values.length%2?values[middle]:(values[middle-1]+values[middle])/2):null,top5Share:total?values.slice(-5).reduce((s,v)=>s+v,0)/total:null,monthly:[...monthly.values()].sort((a,b)=>b.month.localeCompare(a.month)),undated:rows.filter(r=>!r.listing_date).length,bands};
}
export function csvText(records:readonly (readonly unknown[])[]) {return '\uFEFF'+records.map(r=>r.map(v=>'"'+String(v??'').replace(/^[=+@-]/,m=>"'"+m).replaceAll('"','""')+'"').join(',')).join('\r\n');}
export function saveCsv(records:readonly (readonly unknown[])[],name:string) {
  const url=URL.createObjectURL(new Blob([csvText(records)],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
