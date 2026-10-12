import { describe, expect, it } from "vitest";
import { ahDiscount, estimatedOfferSize, ipoFirstDayReturn, rankActiveAhByPredictedIssue, rankListedAhSponsors, rankSponsorsByProceeds, summarizeActiveAh, summarizeListedAh } from "../lib/metrics";

describe("financial calculations", () => {
  it("calculates first-day return", () => expect(ipoFirstDayReturn(10, 11)).toBeCloseTo(0.1));
  it("uses HKD/CNY conversion in A/H discount", () => expect(ahDiscount(8, 0.92, 10)).toBeCloseTo(0.264));
  it("keeps green shoe separate from base offer size", () => expect(estimatedOfferSize(100, 0.2, 0.1, true)).toEqual({ hValuation: 80, base: 8, maximum: 9.2 }));
  it("returns null for invalid denominators", () => expect(ahDiscount(8, 0.92, 0)).toBeNull());
  it("does not turn non-finite inputs into financial figures", () => {
    expect(ahDiscount(NaN, 0.92, 10)).toBeNull();
    expect(estimatedOfferSize(Infinity, 0.2, 0.1, true)).toBeNull();
    expect(ipoFirstDayReturn(Infinity, 10)).toBeNull();
  });
});

describe("dashboard summaries", () => {
  it("uses raw proceeds to break rounded ties", () => {
    const rows = [
      { sponsor: "smaller", current_year_ipo_count: 5, current_year_attributed_proceeds_hkd_bn: 1, current_year_attributed_proceeds_hkd: 1_001_000_000 },
      { sponsor: "larger", current_year_ipo_count: 1, current_year_attributed_proceeds_hkd_bn: 1, current_year_attributed_proceeds_hkd: 1_004_000_000 },
    ];
    expect(rankSponsorsByProceeds(rows)[0].sponsor).toBe("larger");
  });
  it("keeps introduction listings out of IPO sponsor rankings", () => {
    const rows = [
      { company_name: "Introduction", hk_code: "00001", hk_listing_date: "2026-01-01", hk_proceeds_hkd: 0, sponsors: ["Excluded sponsor"], is_fundraising_ipo: false },
    ];
    expect(rankListedAhSponsors(rows)).toEqual([]);
    expect(summarizeListedAh(rows.map((r) => ({ ...r, a_exchange: "SSE", a_market_cap_rmb_bn: null })), { "2026": 100 })[0]).toMatchObject({ count: 1, fundraisingIpoCount: 0, shareOfAnnualIpoPct: 0 });
  });
  it("ranks listed sponsors by current-year Full Credit proceeds", () => {
    const rows = [
      { sponsor: "项目多但募资少", current_year_ipo_count: 9, current_year_attributed_proceeds_hkd_bn: 20 },
      { sponsor: "项目少但募资多", current_year_ipo_count: 2, current_year_attributed_proceeds_hkd_bn: 100 },
    ];
    expect(rankSponsorsByProceeds(rows).map((item) => item.sponsor)).toEqual(["项目少但募资多", "项目多但募资少"]);
  });

  it("summarizes active A-to-H applicants by market-cap band", () => {
    const summary = summarizeActiveAh([
      { a_market_cap_band: "200–500亿元", status: "AP", a_market_cap_rmb_bn: 300, estimated_h_valuation_rmb_bn: 240, estimated_base_issue_rmb_bn: 24, estimated_max_issue_rmb_bn: 27.6 },
      { a_market_cap_band: "200–500亿元", status: "PHIP", a_market_cap_rmb_bn: 400, estimated_h_valuation_rmb_bn: 320, estimated_base_issue_rmb_bn: 32, estimated_max_issue_rmb_bn: 36.8 },
    ]);
    expect(summary[0]).toMatchObject({ count: 2, apCount: 1, phipCount: 1, aMarketCapRmbBn: 700, baseIssueRmbBn: 56 });
  });

  it("summarizes listed A-to-H deals by listing year", () => {
    const summary = summarizeListedAh([
      { hk_listing_date: "2026-01-01", a_exchange: "SSE", hk_proceeds_hkd: 2_000_000_000, a_market_cap_rmb_bn: 100 },
      { hk_listing_date: "2026-02-01", a_exchange: "SZSE", hk_proceeds_hkd: 4_000_000_000, a_market_cap_rmb_bn: 200 },
    ], { "2026": 100 });
    expect(summary[0]).toMatchObject({ year: "2026", count: 2, sseCount: 1, szseCount: 1, proceedsHkdBn: 6, averageProceedsHkdBn: 3, shareOfAnnualIpoPct: 2 });
  });

  it("ranks listed A-to-H sponsors by actual HKEX proceeds and keeps split credit", () => {
    const ranking = rankListedAhSponsors([
      { company_name: "项目甲", hk_code: "00001", hk_listing_date: "2026-01-01", hk_proceeds_hkd: 6_000_000_000, sponsors: ["甲机构", "乙机构"] },
      { company_name: "项目乙", hk_code: "00002", hk_listing_date: "2026-02-01", hk_proceeds_hkd: 4_000_000_000, sponsors: ["乙机构"] },
    ]);
    expect(ranking.map((item) => item.sponsor)).toEqual(["乙机构", "甲机构"]);
    expect(ranking[0]).toMatchObject({ dealCount: 2, fullCreditProceedsHkdBn: 10, splitCreditProceedsHkdBn: 7 });
    expect(ranking[1]).toMatchObject({ dealCount: 1, fullCreditProceedsHkdBn: 6, splitCreditProceedsHkdBn: 3 });
  });

  it("ranks active A-to-H applicants by predicted post-greenshoe issue size", () => {
    const ranking = rankActiveAhByPredictedIssue([
      { company_name: "项目甲", estimated_max_issue_rmb_bn: 12 },
      { company_name: "项目乙", estimated_max_issue_rmb_bn: 28 },
      { company_name: "待行情", estimated_max_issue_rmb_bn: null },
    ]);
    expect(ranking.map((item) => item.company_name)).toEqual(["项目乙", "项目甲", "待行情"]);
  });
});
