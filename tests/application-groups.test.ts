import { describe, expect, it } from "vitest";
import { groupApplications } from "../lib/application-groups";
import dashboard from "../data/processed/dashboard.json";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplicationsView, AhView } from "../app/components/Dashboard";

describe("company-first pipeline layout", () => {
  it("groups duplicate IDs without discarding evidence", () => {
    const groups = groupApplications(dashboard.active_applications);
    expect(groups.length).toBe(dashboard.active_application_scope.unique_company_names);
    expect(groups.flatMap(r => r.records).length).toBe(dashboard.active_application_count);
    const duplicate = groupApplications([
      {company_name: "测试股份有限公司", application_id: "108691", latest_document_date: "2026-01-01"},
      {company_name: "测试股份有限公司 - H股", application_id: "108800", latest_document_date: "2026-02-01"},
    ])[0];
    expect(duplicate.records).toHaveLength(2);
    expect(duplicate.records.map(r => r.application_id)).toContain("108691");
    expect(duplicate.latest.application_id).toBe("108800");
  });
  it("retains regulatory totals with explicit scope separation", () => {
    const html = renderToStaticMarkup(createElement(ApplicationsView));
    expect(html).toContain("核验后公开申请明细");
    expect(html).toContain("宗审核处理中");
    expect(html).toContain("不能用储备项目补齐差额");
    expect(html).toContain("全市场上市观察池");
    expect(html).not.toContain("公开AP记录");
    expect(html).toContain("每页25家");
  });
  it("defaults A to H to project details, with analytics behind a separate view", () => {
    const html = renderToStaticMarkup(createElement(AhView));
    expect(html).toContain("公司明细");
    expect(html).toContain("市值统计与发行规模排名");
    expect(html).not.toContain("当前申请详细汇总");
    expect(html).not.toContain("当前A→H分市值档预测发行规模排名");
  });
});
