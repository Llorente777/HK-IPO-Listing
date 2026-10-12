import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { pipelineCompanies, pipelineSponsors, summarizePipeline, scenario, groupPipelineBands, pipelineCsv } from '../lib/pipeline-analytics';
import { PipelineExplorer, SponsorProjects } from '../app/components/PipelineExplorer';
import watch from '../public/data/pipeline_watch.json';
import { PipelineNavigation } from '../app/components/PipelineWatch';
import { applicationScopeNote } from '../lib/application-scope';
import dashboard from '../data/processed/dashboard.json';
import { applicationCompanyKey } from '../lib/application-groups';

describe('pipeline aggregation and scenarios',()=>{
  it('labels research counts separately from original all-market and A/H indices',()=>{
    const count=(rows:{company_name:string}[])=>new Set(rows.map(r=>applicationCompanyKey(r.company_name))).size;
    for(const onlyAh of [false,true]) {
      const raw=count(onlyAh?dashboard.a_to_h_active:dashboard.active_applications);
      const kept=count(onlyAh?dashboard.research_a_to_h_active:dashboard.research_active_applications);
      expect(applicationScopeNote(onlyAh)).toBe(`原始${raw}家，剔除已上市／明确终止${raw-kept}家`);
    }
    const html=renderToStaticMarkup(createElement(PipelineNavigation,{value:'active',onChange:()=>{}}));
    expect(html).toContain('核验后公开申请');
    expect(html).toContain(applicationScopeNote());
    expect(html).toContain(String(pipelineCompanies.filter(r=>r.category==='active').length));
  });
  it('exports only selected rows with the chosen scenario and evidence tiers',()=>{
    const row=pipelineCompanies.find(r=>r.category==='confidential'&&r.a_market_cap_rmb_bn!=null)!;
    const csv=pipelineCsv([row],0,10,false);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(2);
    expect(csv).toContain(row.company_name);expect(csv).toContain(row.confidential_tier_label!);
    expect(csv).toContain(String(row.a_market_cap_rmb_bn!*.1));
    expect(pipelineCsv([]).split('\r\n')).toHaveLength(1);
  });
  it('retains the evidence-qualified, exclusive company universe',()=>{
    expect(pipelineCompanies.map(r=>r.id).sort()).toEqual(watch.rows.map(r=>r.id).sort());
    expect(new Set(pipelineCompanies.map(r=>r.id)).size).toBe(pipelineCompanies.length);
    expect(pipelineCompanies.filter(r=>r.category==='active').length).toBe(watch.rows.filter(r=>r.status==='public_active').length);
    expect(pipelineCompanies.filter(r=>r.category==='reserve').length).toBe(watch.rows.filter(r=>r.bucket==='public'&&r.status!=='public_active').length);
    expect(pipelineCompanies.filter(r=>r.category==='confidential').length).toBe(watch.rows.filter(r=>r.bucket==='confidential').length);
  });
  it('reconciles category totals and excludes missing amounts',()=>{
    const ah=pipelineCompanies.filter(r=>r.is_a_to_h),total=summarizePipeline(ah);
    const parts=['active','reserve','confidential'].map(c=>summarizePipeline(ah.filter(r=>r.category===c)));
    expect(parts.reduce((s,r)=>s+r.max,0)).toBeCloseTo(total.max,8);
    expect(groupPipelineBands(ah).reduce((s,r)=>s+r.count,0)).toBe(ah.length);
    const row=ah[0];expect(scenario(row,0,10,false)!.base).toBeCloseTo(row.a_market_cap_rmb_bn!*0.1);
    expect(scenario({...row,a_market_cap_rmb_bn:null})).toBeNull();
    for(const r of ah) if(r.a_market_cap_rmb_bn!=null){expect(r.market_data_date).toBeTruthy();expect(r.market_data_source_url).toMatch(/^https:/);}
  });
  it('reconciles sponsor project counts without inventing confidential mandates',()=>{
    for(const s of pipelineSponsors(pipelineCompanies.filter(r=>r.category==='active'))){expect(s.ap+s.phip).toBe(s.projects.length);expect(new Set(s.projects.map(r=>r.id)).size).toBe(s.projects.length);}
    expect(pipelineCompanies.filter(r=>r.category==='confidential').every(r=>!r.sponsors.length)).toBe(true);
    expect(renderToStaticMarkup(createElement(SponsorProjects))).toContain('查看全部公司');
  });
  it('renders both reserve types with model controls and evidence, not AP labels',()=>{
    for(const category of ['reserve','confidential']) {
      const html=renderToStaticMarkup(createElement(PipelineExplorer,{onlyAh:true,category}));
      expect(html).toContain('市值统计与发行规模排名');expect(html).toContain('绿鞋后规模');expect(html).toContain('查看原文件与证据');expect(html).not.toContain('<small>AP</small>');
    }
  });
  it('shows overdue secret evidence and incomplete historical sponsor coverage',()=>{
    const html=renderToStaticMarkup(createElement(PipelineExplorer,{category:'confidential'}));
    expect(html).toContain('超过90天');expect(html).toContain('进展待复核');
    const sponsors=renderToStaticMarkup(createElement(SponsorProjects,{category:'reserve'}));
    expect(sponsors).toContain('不是完整市场份额');expect(sponsors).toContain('保荐人信息覆盖');
  });
});
