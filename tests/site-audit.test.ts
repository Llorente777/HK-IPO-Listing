import {describe,it,expect} from 'vitest';
import {readRoute,routeHash} from '../lib/site-navigation';
import {ipoStatistics,csvText} from '../lib/research-statistics';
import {GET} from '../app/api/export/route';
import dashboard from '../data/processed/dashboard.json';
import {pipelineCompanies,rankPipeline} from '../lib/pipeline-analytics';
import {applicationCompanyKey} from '../lib/application-groups';
import {exportUrl} from '../lib/export-url';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SourceLink} from '../app/components/SourceLink';
import audit from '../public/data/link_audit.json';

describe('navigation, statistics and real export endpoints',()=>{
  it('keeps original regulator records but excludes resolved conflicts from research exports',async()=>{
    for(const conflict of dashboard.active_state_conflicts) {
      for(const id of conflict.active_application_ids) {
        expect(dashboard.active_applications.some(r=>r.application_id===id)).toBe(true);
        expect(dashboard.research_active_applications.some(r=>r.application_id===id)).toBe(false);
        expect(dashboard.research_a_to_h_active.some(r=>r.application_id===id)).toBe(false);
      }
      const response=await GET(new Request('http://localhost'+exportUrl('applications',dashboard.research_active_applications.map((_,i)=>i))));
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(conflict.company_name);
    }
  });
  it('does not present known 404 sources as usable document links',()=>{
    const dead=audit.rows.find(r=>r.http===404)!;
    const html=renderToStaticMarkup(createElement(SourceLink,{href:dead.url},'原文件'));
    expect(html).toContain('原文件地址已失效');expect(html).not.toContain(`href="${dead.url}"`);
    expect(renderToStaticMarkup(createElement(SourceLink,{},'来源'))).toContain('暂无链接');
  });
  it('round trips navigation and encoded searches, rejecting unknown pages',()=>{
    expect(readRoute(routeHash('applications','亿纬 & 300014','sponsors'))).toEqual({tab:'applications',q:'亿纬 & 300014',section:'sponsors'});
    expect(readRoute('#not-a-page').tab).toBe('home');
    expect(readRoute('#ah?section=listed').section).toBe('listed');
  });
  it('reconciles amount buckets and months for actual IPO records',()=>{
    const s=ipoStatistics(dashboard.listings);
    expect(s.bands.reduce((n,r)=>n+r.count,0)).toBe(s.count);
    expect(s.bands.reduce((n,r)=>n+r.proceeds,0)).toBeCloseTo(s.total,0);
    expect(s.monthly.reduce((n,r)=>n+r.count,0)+s.undated).toBe(s.count);
    expect(s.top5Share).toBeGreaterThan(0);expect(s.top5Share).toBeLessThanOrEqual(1);
    expect(ipoStatistics([]).median).toBeNull();
  });
  it('preserves boundary values and CSV quoting safely',()=>{
    const rows=[0,1e9,5e9,1e10].map(total_proceeds_hkd=>({total_proceeds_hkd,company_name:'a',listing_date:'2026-01-01',market:'主板',hk_code:'1'}));
    expect(ipoStatistics(rows).bands.map(b=>b.count)).toEqual([1,1,1,1]);
    expect(csvText([['=bad','a"b']])).toBe('\uFEFF"\'=bad","a""b"');
  });
  for(const dataset of ['ipo','applications','pipeline','watch','ah-listed'])it(`serves selected ${dataset} CSV as an attachment`,async()=>{
    const response=await GET(new Request('http://localhost'+exportUrl(dataset,[0,1])));
    expect(response.status).toBe(200);expect(response.headers.get('Content-Disposition')).toContain('attachment;');
    const bytes=new Uint8Array(await response.arrayBuffer());expect([...bytes.slice(0,3)]).toEqual([239,187,191]);
    expect(new TextDecoder().decode(bytes).split('\r\n')).toHaveLength(3);
  });
  it('exports pipeline with the selected scenario, not stale defaults',async()=>{
    const index=pipelineCompanies.findIndex(r=>r.a_market_cap_rmb_bn!=null),r=pipelineCompanies[index];
    const response=await GET(new Request('http://localhost'+exportUrl('pipeline',[index],{discount:0,ratio:10,shoe:0})));
    const csv=await response.text();expect(csv).toContain(r.company_name);expect(csv).toContain(String(r.a_market_cap_rmb_bn!*.1));
  });
  it('keeps listed companies out of the research pool after composite suffix normalization',()=>{
    expect(applicationCompanyKey('真健康 - B - H 股')).toBe(applicationCompanyKey('真健康 - B'));
    const listed=new Set(dashboard.listings.map(r=>applicationCompanyKey(r.company_name)));
    expect(dashboard.research_active_applications.filter(r=>listed.has(applicationCompanyKey(r.company_name)))).toEqual([]);
    expect(pipelineCompanies.filter(r=>listed.has(applicationCompanyKey(r.company_name)))).toEqual([]);
    expect(dashboard.active_state_conflicts.some(r=>r.listing_evidence?.hk_code==='02697')).toBe(true);
  });
  it('downloads the actual ranking order with rank numbers and the chosen scenario',async()=>{
    const selected=pipelineCompanies.filter(r=>r.is_a_to_h&&r.category==='reserve');
    const ranked=rankPipeline(selected,20,12,false);
    const response=await GET(new Request('http://localhost'+exportUrl('pipeline',selected.map(r=>pipelineCompanies.indexOf(r)),{discount:20,ratio:12,shoe:0,ranked:1})));
    const lines=(await response.text()).replace(/^\uFEFF/,'').split('\r\n');
    expect(lines[0]).toMatch(/^"排名","公司"/);
    expect(lines.slice(1).map((line,i)=>line.startsWith(`"${i+1}","${ranked[i].company_name}"`))).not.toContain(false);
    expect(lines).toHaveLength(ranked.length+1);
  });
  it('historical A/H filtered download never includes current applicants',async()=>{
    const rows=dashboard.a_to_h_listed.filter(r=>r.a_market_cap_band==='100亿元以下');
    const response=await GET(new Request('http://localhost'+exportUrl('ah-listed',rows.map(r=>dashboard.a_to_h_listed.indexOf(r)))));
    const csv=await response.text();
    expect(csv.split('\r\n')).toHaveLength(rows.length+1);
    for(const r of rows)expect(csv).toContain(r.company_name);
    for(const r of dashboard.research_a_to_h_active)expect(csv).not.toContain(r.company_name);
  });
  for(const query of ['dataset=ipo&rows=-1','dataset=ipo&rows=0,0','dataset=ipo&rows=999999','dataset=unknown&rows=0','dataset=pipeline&rows=0&discount=NaN','dataset=pipeline&rows=0&discount=100'])it(`rejects invalid export: ${query}`,async()=>{
    expect((await GET(new Request('http://localhost/api/export?'+query))).status).toBe(400);
  });
});
