import data from './pipeline_analytics.json';
import { ahMarketCapOrder, estimatedOfferSize } from './metrics';
export const pipelineCompanies = data.rows;
export type PipelineCompany = (typeof pipelineCompanies)[number];
export const categoryLabels: Record<string, string> = {all:'全部观察项目', active:'公开有效申请',reserve:'公开递表储备',confidential:'密交储备与线索'};
export function scenario(row: {a_market_cap_rmb_bn:number|null}, discount=35.7, ratio=10, greenshoe=true) {
  return row.a_market_cap_rmb_bn == null ? null : estimatedOfferSize(row.a_market_cap_rmb_bn, discount/100, ratio/100, greenshoe);
}
export function summarizePipeline(rows: PipelineCompany[], discount=35.7, ratio=10, greenshoe=true) {
  const covered = rows.filter(r=>scenario(r,discount,ratio,greenshoe)!=null);
  return { count:rows.length, covered:covered.length,
    cap:covered.reduce((s,r)=>s+r.a_market_cap_rmb_bn!,0),
    h:covered.reduce((s,r)=>s+scenario(r,discount,ratio,greenshoe)!.hValuation,0),
    base:covered.reduce((s,r)=>s+scenario(r,discount,ratio,greenshoe)!.base,0),
    max:covered.reduce((s,r)=>s+scenario(r,discount,ratio,greenshoe)!.maximum,0) };
}
export function groupPipelineBands(rows: PipelineCompany[], discount=35.7,ratio=10,greenshoe=true) {
  return ahMarketCapOrder.map(band=>({band,...summarizePipeline(rows.filter(r=>r.a_market_cap_band===band),discount,ratio,greenshoe)})).filter(r=>r.count);
}
export function pipelineSponsors(rows: PipelineCompany[]) {
  const map=new Map<string,PipelineCompany[]>();
  for(const row of rows) for(const sponsor of new Set(row.sponsors)) map.set(sponsor,[...(map.get(sponsor)||[]),row]);
  return [...map].map(([sponsor,projects])=>({sponsor,projects,ap:projects.filter(r=>r.category==='active'&&!r.has_phip).length,phip:projects.filter(r=>r.category==='active'&&r.has_phip).length,reserve:projects.filter(r=>r.category==='reserve').length})).sort((a,b)=>b.projects.length-a.projects.length||a.sponsor.localeCompare(b.sponsor,'zh-CN'));
}
export function pipelineCsv(rows:PipelineCompany[], discount=35.7,ratio=10,greenshoe=true) {
  const records=[['公司','分类','状态','密交证据分档','证据日期','A股代码','市值RMB bn','行情日期','折价%','发行比例%','绿鞋%','H估值RMB bn','基础规模RMB bn','绿鞋后规模RMB bn','保荐人','保荐关系口径','文件来源','行情来源'],...rows.map(r=>{const s=scenario(r,discount,ratio,greenshoe);return[r.company_name,categoryLabels[r.category],r.status_label,r.confidential_tier_label,r.evidence_date,r.a_code,r.a_market_cap_rmb_bn,r.market_data_date,discount,ratio,greenshoe?15:0,s?.hValuation,s?.base,s?.maximum,r.sponsors.join(' / '),r.sponsor_basis,r.prospectus_url||r.classification_source?.url||r.official_url,r.market_data_source_url];})];
  const csv=records.map(row=>row.map(v=>'"'+String(v??'').replace(/^[=+@-]/,m=>"'"+m).replaceAll('"','""')+'"').join(',')).join('\r\n');
  return '\uFEFF'+csv;
}
export function downloadPipeline(rows:PipelineCompany[], discount=35.7,ratio=10,greenshoe=true) {
  const url=URL.createObjectURL(new Blob([pipelineCsv(rows,discount,ratio,greenshoe)],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='pipeline-current-selection.csv';
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
