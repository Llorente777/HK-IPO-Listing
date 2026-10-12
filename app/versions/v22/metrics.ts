export function ipoFirstDayReturn(offerPrice: number, closePrice: number) {
  if (![offerPrice, closePrice].every(Number.isFinite) || !(offerPrice > 0) || closePrice < 0) return null;
  return closePrice / offerPrice - 1;
}

export function ahDiscount(hPriceHkd: number, hkdCny: number, aPriceCny: number) {
  if (![hPriceHkd, hkdCny, aPriceCny].every(Number.isFinite) || !(aPriceCny > 0) || hPriceHkd < 0 || hkdCny <= 0) return null;
  return 1 - (hPriceHkd * hkdCny) / aPriceCny;
}

export function estimatedOfferSize(aMarketCapCny: number, discount: number, issueRatio: number, greenShoe: boolean) {
  if (![aMarketCapCny, discount, issueRatio].every(Number.isFinite) || aMarketCapCny < 0 || discount < 0 || discount >= 1 || issueRatio < 0 || issueRatio > 1) return null;
  const hValuation = aMarketCapCny * (1 - discount);
  const base = hValuation * issueRatio;
  return { hValuation, base, maximum: greenShoe ? base * 1.15 : base };
}

export function rankSponsorsByProceeds<T extends {
  sponsor: string;
  current_year_attributed_proceeds_hkd_bn: number;
  current_year_attributed_proceeds_hkd?: number;
  current_year_ipo_count: number;
}>(rows: readonly T[]) {
  return [...rows].sort((left, right) =>
    (right.current_year_attributed_proceeds_hkd ?? right.current_year_attributed_proceeds_hkd_bn * 1e9)
    - (left.current_year_attributed_proceeds_hkd ?? left.current_year_attributed_proceeds_hkd_bn * 1e9)
    || right.current_year_ipo_count - left.current_year_ipo_count
    || left.sponsor.localeCompare(right.sponsor, "zh-CN")
  );
}

export const ahMarketCapOrder = [
  "1,000亿元以上",
  "500–1,000亿元",
  "200–500亿元",
  "100–200亿元",
  "100亿元以下",
  "待官方行情",
];

export function summarizeActiveAh(rows: readonly {
  a_market_cap_band: string;
  status: string;
  a_market_cap_rmb_bn: number | null;
  estimated_h_valuation_rmb_bn: number | null;
  estimated_base_issue_rmb_bn: number | null;
  estimated_max_issue_rmb_bn: number | null;
}[]) {
  const groups = new Map<string, {
    band: string;
    count: number;
    apCount: number;
    phipCount: number;
    marketDataCount: number;
    aMarketCapRmbBn: number;
    hValuationRmbBn: number;
    baseIssueRmbBn: number;
    maxIssueRmbBn: number;
  }>();
  for (const row of rows) {
    const band = row.a_market_cap_band || "待官方行情";
    const group = groups.get(band) ?? {
      band, count: 0, apCount: 0, phipCount: 0, marketDataCount: 0,
      aMarketCapRmbBn: 0, hValuationRmbBn: 0, baseIssueRmbBn: 0, maxIssueRmbBn: 0,
    };
    group.count += 1;
    if (row.status.includes("PHIP")) group.phipCount += 1;
    else group.apCount += 1;
    if (row.a_market_cap_rmb_bn != null) group.marketDataCount += 1;
    group.aMarketCapRmbBn += row.a_market_cap_rmb_bn ?? 0;
    group.hValuationRmbBn += row.estimated_h_valuation_rmb_bn ?? 0;
    group.baseIssueRmbBn += row.estimated_base_issue_rmb_bn ?? 0;
    group.maxIssueRmbBn += row.estimated_max_issue_rmb_bn ?? 0;
    groups.set(band, group);
  }
  return [...groups.values()].sort((left, right) => {
    const leftIndex = ahMarketCapOrder.indexOf(left.band);
    const rightIndex = ahMarketCapOrder.indexOf(right.band);
    return (leftIndex < 0 ? ahMarketCapOrder.length : leftIndex) - (rightIndex < 0 ? ahMarketCapOrder.length : rightIndex);
  });
}

export function summarizeListedAh(rows: readonly {
  hk_listing_date: string | null;
  a_exchange: string;
  hk_proceeds_hkd: number | null;
  a_market_cap_rmb_bn: number | null;
  is_fundraising_ipo?: boolean;
}[], annualIpoCounts: Readonly<Record<string, number>>) {
  const groups = new Map<string, {
    year: string;
    count: number;
    fundraisingIpoCount: number;
    sseCount: number;
    szseCount: number;
    marketDataCount: number;
    proceedsHkdBn: number;
    aMarketCapRmbBn: number;
  }>();
  for (const row of rows) {
    const year = row.hk_listing_date?.slice(0, 4) || "待核验";
    const group = groups.get(year) ?? {
      year, count: 0, fundraisingIpoCount: 0, sseCount: 0, szseCount: 0, marketDataCount: 0,
      proceedsHkdBn: 0, aMarketCapRmbBn: 0,
    };
    group.count += 1;
    if (row.is_fundraising_ipo !== false) group.fundraisingIpoCount += 1;
    if (row.a_exchange === "SSE") group.sseCount += 1;
    if (row.a_exchange === "SZSE") group.szseCount += 1;
    if (row.a_market_cap_rmb_bn != null) group.marketDataCount += 1;
    group.proceedsHkdBn += (row.hk_proceeds_hkd ?? 0) / 1_000_000_000;
    group.aMarketCapRmbBn += row.a_market_cap_rmb_bn ?? 0;
    groups.set(year, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    shareOfAnnualIpoPct: annualIpoCounts[group.year] ? group.fundraisingIpoCount / annualIpoCounts[group.year] * 100 : null,
    averageProceedsHkdBn: group.fundraisingIpoCount ? group.proceedsHkdBn / group.fundraisingIpoCount : 0,
  })).sort((left, right) => right.year.localeCompare(left.year));
}

export function rankListedAhSponsors(rows: readonly {
  company_name: string;
  hk_code: string;
  hk_listing_date: string | null;
  hk_proceeds_hkd: number | null;
  sponsors: readonly string[];
  is_fundraising_ipo?: boolean;
}[]) {
  const sponsors = new Map<string, {
    sponsor: string;
    dealCount: number;
    fullCreditProceedsHkdBn: number;
    splitCreditProceedsHkdBn: number;
    largestDeal: { companyName: string; hkCode: string; proceedsHkdBn: number } | null;
  }>();
  for (const row of rows) {
    if (row.is_fundraising_ipo === false) continue;
    const uniqueSponsors = [...new Set(row.sponsors.filter(Boolean))];
    if (!uniqueSponsors.length) continue;
    const proceedsHkdBn = (row.hk_proceeds_hkd ?? 0) / 1_000_000_000;
    for (const sponsor of uniqueSponsors) {
      const entry = sponsors.get(sponsor) ?? {
        sponsor,
        dealCount: 0,
        fullCreditProceedsHkdBn: 0,
        splitCreditProceedsHkdBn: 0,
        largestDeal: null,
      };
      entry.dealCount += 1;
      entry.fullCreditProceedsHkdBn += proceedsHkdBn;
      entry.splitCreditProceedsHkdBn += proceedsHkdBn / uniqueSponsors.length;
      if (!entry.largestDeal || proceedsHkdBn > entry.largestDeal.proceedsHkdBn) {
        entry.largestDeal = {
          companyName: row.company_name,
          hkCode: row.hk_code,
          proceedsHkdBn,
        };
      }
      sponsors.set(sponsor, entry);
    }
  }
  return [...sponsors.values()].map((entry) => ({
    ...entry,
    averageDealProceedsHkdBn: entry.dealCount ? entry.fullCreditProceedsHkdBn / entry.dealCount : 0,
  })).sort((left, right) =>
    right.fullCreditProceedsHkdBn - left.fullCreditProceedsHkdBn
    || right.dealCount - left.dealCount
    || left.sponsor.localeCompare(right.sponsor, "zh-CN")
  );
}

export function rankActiveAhByPredictedIssue<T extends {
  company_name: string;
  estimated_max_issue_rmb_bn: number | null;
}>(rows: readonly T[]) {
  return [...rows].sort((left, right) =>
    (right.estimated_max_issue_rmb_bn ?? -1) - (left.estimated_max_issue_rmb_bn ?? -1)
    || left.company_name.localeCompare(right.company_name, "zh-CN")
  );
}
