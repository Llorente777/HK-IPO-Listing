import dashboard from '@/data/processed/dashboard.json';
import watch from '@/data/processed/pipeline_watch.json';
import { pipelineCompanies, pipelineCsv, rankPipeline } from '@/lib/pipeline-analytics';
import { csvText } from '@/lib/research-statistics';
export async function GET(request:Request) {
  const p=new URL(request.url).searchParams,dataset=p.get('dataset'),raw=p.get('rows');
  if(raw==null||raw.length>10000||!/^\d*(,\d+)*$/.test(raw))return new Response('Invalid row selection',{status:400});
  const indices=raw===''?[]:raw.split(',').map(Number);
  const source=dataset==='pipeline'?pipelineCompanies:dataset==='ipo'?dashboard.listings:dataset==='ah-listed'?dashboard.a_to_h_listed:dataset==='applications'?dashboard.research_active_applications:dataset==='watch'?watch.rows:null;
  if(!source||new Set(indices).size!==indices.length||indices.some(i=>!Number.isSafeInteger(i)||i<0||i>=source.length))return new Response('Invalid dataset or row index',{status:400});
  let csv='';
  if(dataset==='pipeline') {
    const discount=Number(p.get('discount')??35.7),ratio=Number(p.get('ratio')??10),shoe=p.get('shoe')??'1';
    if(!Number.isFinite(discount)||discount<0||discount>=100||!Number.isFinite(ratio)||ratio<0||ratio>100||!['0','1'].includes(shoe))return new Response('Invalid scenario',{status:400});
    const ranked=p.get('ranked')??'0';
    if(!['0','1'].includes(ranked))return new Response('Invalid ranking option',{status:400});
    const selected=indices.map(i=>pipelineCompanies[i]);
    csv=pipelineCsv(ranked==='1'?rankPipeline(selected,discount,ratio,shoe==='1'):selected,discount,ratio,shoe==='1',ranked==='1');
  } else if(dataset==='ipo')csv=csvText([['公司','港股代码','上市日','市场','募资港元','保荐人','原文件'],...indices.map(i=>{const r=dashboard.listings[i];return[r.company_name,r.hk_code,r.listing_date,r.market,r.total_proceeds_hkd,r.sponsors.join(' / '),r.original_document_url||r.source_url];})]);
  else if(dataset==='ah-listed')csv=csvText([['公司','A股代码','港股代码','港股上市日','上市方式','是否募资IPO','市值档','A股市值RMB bn','行情日期','实际募资港元','保荐人','港交所来源'],...indices.map(i=>{const r=dashboard.a_to_h_listed[i];return[r.company_name,r.a_code,r.hk_code,r.hk_listing_date,r.hk_listing_method,r.is_fundraising_ipo?'是':'否',r.a_market_cap_band,r.a_market_cap_rmb_bn,r.market_data_date,r.hk_proceeds_hkd,r.sponsors.join(' / '),r.hk_official_url];})]);
  else if(dataset==='applications')csv=csvText([['公司','申请ID','最新文件日','阶段','保荐人','保荐人披露文件'],...indices.map(i=>{const r=dashboard.research_active_applications[i];return[r.company_name,r.application_id,r.latest_document_date,r.has_phip?'PHIP':'AP',r.sponsors.join(' / '),r.sponsor_source_url||r.warning_url];})]);
  else {
    const evidence = new Map(pipelineCompanies.map(r=>[r.id,r]));
    csv=csvText([['公司','A股代码','状态','密交档位','最近招股书更新','证据日期','分档来源','全部证据链接','终止检索日期','保荐机构','保荐关系口径','保荐人披露文件'],...indices.map(i=>{const r=watch.rows[i], a=evidence.get(r.id), verified=a?.sponsor_source_url && a.sponsors.length;return[r.company_name,r.a_code,r.status_label,r.confidential_tier_label,r.last_prospectus_update_date,r.evidence_date,r.classification_source?.url,r.events.map(e=>e.url).join(' | '),r.termination_review?.checked_at,verified?a.sponsors.join(' / '):'待核实',verified?a.sponsor_basis:'未取得可核验证据',verified?a.sponsor_source_url:''];})]);
  }
  return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${dataset}-current-selection.csv"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
