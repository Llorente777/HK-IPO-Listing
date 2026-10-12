import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineWatch, PipelineNavigation, watchRows, reserveSponsors } from "../app/components/PipelineWatch";
import watch from "../public/data/pipeline_watch.json";
import { pipelineCompanies } from '../lib/pipeline-analytics';
import { GET } from '../app/api/export/route';

describe("pipeline watch presentation", () => {
  it('displays and searches verified historical sponsors without implying a current mandate', async () => {
    const row = pipelineCompanies.find(r=>r.category==='reserve' && r.sponsors.length && r.sponsor_source_url)!;
    const html = renderToStaticMarkup(createElement(PipelineWatch, {initialFilter:row.sponsors[0]}));
    expect(html).toContain('历史披露保荐人');
    expect(html).toContain(row.company_name);
    expect(html).toContain(row.sponsor_source_url);
    expect(html).toContain('历史披露，是否续任待核');
    expect(html).toContain('保荐信息待核实');
    expect(reserveSponsors('missing-company')).toEqual([]);
    const index = watch.rows.findIndex(r=>r.id===row.id);
    const response = await GET(new Request(`https://example.test/api/export?dataset=watch&rows=${index}`));
    const csv = await response.text();
    expect(csv).toContain(row.sponsors[0]);
    expect(csv).toContain(row.sponsor_source_url);
    expect(csv).toContain('保荐关系口径');
  });
  it("uses mutually exclusive categories and independently verified confidential A shares", () => {
    const active = watchRows.filter(r => r.status === "public_active");
    const reserve = watchRows.filter(r => r.bucket === "public" && r.status !== "public_active");
    const secret = watchRows.filter(r => r.bucket === "confidential");
    expect(active.length + reserve.length + secret.length).toBe(watchRows.length);
    expect(reserve.every(r => r.termination_review?.checked_at)).toBe(true);
    const html = renderToStaticMarkup(createElement(PipelineNavigation, {value:"reserve",onChange:()=>{}}));
    expect(html).toContain("三类互不重复");
    const ah = renderToStaticMarkup(createElement(PipelineWatch, {onlyAh:true,category:"confidential"}));
    expect(ah).toContain("688019");
    expect(ah).toContain("公司或官方确认");
    expect(ah).not.toContain("强脑科技");
    expect(secret.every(r => r.classification_source?.url && r.classification_source?.publisher)).toBe(true);
    expect(secret.filter(r => r.confidential_tier === "tier1").length + secret.filter(r => r.confidential_tier === "tier2").length).toBe(secret.length);
  });
  it("keeps reported confidentiality visibly separate from official applications", () => {
    const html = renderToStaticMarkup(createElement(PipelineWatch, { initialFilter: "Kimi", category: "confidential" }));
    expect(html).toContain("据报保密递交·未获官方确认");
    expect(html).toContain("不并入公开有效AP/PHIP");
    expect(html).toContain("不含官方公开有效申请");
    expect(html).toContain("保密递交储备");
    expect(html).toContain("证据快照 JSON");
  });
  it("limits A→H table to verified A-share companies", () => {
    const html = renderToStaticMarkup(createElement(PipelineWatch, { onlyAh: true }));
    expect(html).toContain("惠州亿纬锂能股份有限公司");
    expect(html).toContain("300014");
    expect(html).toContain("https://static.cninfo.com.cn/finalpage/2026-07-04/1225409734.PDF");
    expect(html).not.toContain("月之暗面（Kimi）");
    expect(html).toContain("/data/a_to_h_watch.csv");
    expect(html).toContain("2023-02-17");
    expect(html).toContain(watch.public_update_cutoff);
    expect(html).toContain("最近招股书更新");
  });
  it("shows market leads separately and does not call them confirmed filings", () => {
    const html = renderToStaticMarkup(createElement(PipelineWatch, {initialFilter:"阶跃星辰",category:"confidential"}));
    expect(html).toContain("第二档·媒体／市场线索");
    expect(html).toContain("市场传闻已密交·待核实");
    expect(html).toContain("同壁财经（新浪看点发布）");
    expect(html).toContain("不证明已经递交");
    expect(html).not.toContain("上海）股份有限公司</b>");
  });
});
