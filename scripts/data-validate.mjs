import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const root = process.cwd();
const readJson = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));
const manifest = await readJson("data/raw_manifest.json");
const snapshot = await readJson("data/processed/full_snapshot.json");
const dashboard = await readJson("data/processed/dashboard.json");
for (const name of ['pipeline_watch.json','pipeline_analytics.json','link_audit.json']) {
  const client = await readFile(join(root,'data/processed',name));
  const download = await readFile(join(root,'public/data',name));
  if (!client.equals(download)) throw new Error(`Client/download snapshot mismatch: ${name}`);
}

// The last published baseline covered 372/381 applications. Missing entries
// remain explicitly missing; a mass extraction failure must not ship as zero.
const sponsorCoverage = dashboard.active_applications.filter((row) => row.sponsors?.length).length;
if (dashboard.active_applications.length && sponsorCoverage / dashboard.active_applications.length < 0.90) {
  throw new Error(`AP sponsor extraction coverage regression: ${sponsorCoverage}/${dashboard.active_applications.length}; publication blocked`);
}

const sponsorValues = [
  ...dashboard.listings.flatMap((row) => row.sponsors ?? []),
  ...dashboard.active_applications.flatMap((row) => row.sponsors ?? []),
];
const suspiciousSponsors = [...new Set(sponsorValues.filter((value) =>
  /保荐人|协调人|排序不分先后|按字母顺序|编纂/.test(value)
  || /法律顾问|^整体|^整中|^）|国际金融中心/.test(value)
  || /^\(/.test(value)
  || /有限公$/.test(value)
  || (value.match(/有限公司/g)?.length ?? 0) > 1
))];
if (suspiciousSponsors.length) throw new Error(`Invalid sponsor labels: ${suspiciousSponsors.join(" | ")}`);

const sponsorVariants = new Map();
for (const value of sponsorValues) {
  const key = value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const variants = sponsorVariants.get(key) ?? new Set();
  variants.add(value);
  sponsorVariants.set(key, variants);
}
const duplicateSponsorVariants = [...sponsorVariants.values()].filter((values) => values.size > 1);
if (duplicateSponsorVariants.length) {
  throw new Error(`Duplicate sponsor variants: ${duplicateSponsorVariants.map((values) => [...values].join(" / ")).join(" | ")}`);
}

const sourceSchema = z.object({
  source: z.string().min(1), url: z.string().url(), local_file: z.string().min(1),
  bytes: z.number().int().positive(), sha256: z.string().length(64),
  fetched_at: z.iso.datetime({ offset: true }),
  cache_status: z.enum(["downloaded", "reused", "manual-official-export", "reused-last-official-close", "reused-verified-no-change"]),
  source_as_of: z.string().optional(),
});
z.array(sourceSchema).min(10).parse(manifest.documents);

if (snapshot.excel_dependency !== false) throw new Error("Production snapshot must not depend on Excel");
if (snapshot.schema_version !== "2.2.0" || dashboard.schema_version !== snapshot.schema_version) throw new Error("Snapshot schema version mismatch");
if (snapshot.listings.length !== snapshot.coverage.listing_records) throw new Error("Listing coverage count mismatch");
if (snapshot.excluded_non_ipo_listings.length !== snapshot.coverage.non_ipo_listing_records_excluded) throw new Error("Non-IPO exclusion coverage count mismatch");
if (snapshot.active_applications.length !== snapshot.coverage.active_application_records) throw new Error("Active-application coverage count mismatch");
if (snapshot.application_history.length !== snapshot.coverage.application_history_records) throw new Error("Application-history coverage count mismatch");
if (snapshot.a_to_h_listed.length !== snapshot.coverage.a_to_h_listed_verified) throw new Error("A→H listed count mismatch");
if (snapshot.a_to_h_active.length !== snapshot.coverage.a_to_h_active_verified) throw new Error("A→H active count mismatch");
if (dashboard.snapshot_date !== snapshot.snapshot_date) throw new Error("Dashboard/snapshot date mismatch");
const weeklyChanges = snapshot.weekly_changes;
if (!weeklyChanges || weeklyChanges.comparison_to !== snapshot.snapshot_date) throw new Error("Weekly change period is missing or stale");
if (!weeklyChanges.baseline && (!weeklyChanges.comparison_from || weeklyChanges.comparison_from >= weeklyChanges.comparison_to)) throw new Error("Invalid weekly comparison period");
const activeScope = snapshot.active_application_scope;
if (!activeScope || activeScope.unique_application_records !== snapshot.active_applications.length) throw new Error("Official active-application scope mismatch");
const officialActiveRows = Object.values(activeScope.components ?? {}).reduce((sum, value) => sum + Number(value), 0);
if (officialActiveRows !== activeScope.official_index_rows) throw new Error("Official active-index component mismatch");
if (officialActiveRows - activeScope.duplicate_application_ids_removed !== activeScope.unique_application_records) throw new Error("Official active-index de-duplication mismatch");
const normalizeCompany = (value) => value.normalize("NFKC").toLowerCase()
  .replace(/\s*\((?:前称为?|前稱為?|曾用名[:：]?|formerly(?: known as)?)\s*[^)]*\)/g, "")
  .replace(/(?:\s*[-—–－]\s*(?:h\s*股|[bpswz]{1,3}))+\s*$/g, "")
  .replace(/[-—–－·•（）()【】,，.。/\\\s]/g, "").replaceAll("[", "").replaceAll("]", "")
  .replaceAll("股份有限公司", "").replaceAll("集团有限公司", "").replaceAll("控股有限公司", "")
  .replaceAll("有限公司", "").replaceAll("股份", "").replaceAll("集团", "").replaceAll("控股", "")
  .replaceAll("h股公司", "").replaceAll("h股", "");
const activeCompanyGroups = new Map();
for (const row of snapshot.active_applications) {
  const key = normalizeCompany(row.company_name);
  activeCompanyGroups.set(key, (activeCompanyGroups.get(key) ?? 0) + 1);
}
const duplicateCompanyGroups = [...activeCompanyGroups.values()].filter((count) => count > 1).length;
if (activeScope.unique_company_names !== activeCompanyGroups.size || activeScope.duplicate_company_name_groups !== duplicateCompanyGroups) {
  throw new Error("Official current-application company de-duplication mismatch");
}
const processingReports = snapshot.official_processing_statistics;
if (!Array.isArray(processingReports) || processingReports.length < 1) throw new Error("Missing HKEX monthly processing statistic");
for (const report of processingReports) {
  const componentTotal = Object.values(report.components ?? {}).reduce((sum, value) => sum + Number(value), 0);
  if (componentTotal !== report.under_processing_total) throw new Error(`HKEX processing statistic does not reconcile: ${report.as_of}`);
  if (report.as_of > snapshot.snapshot_date || !report.source_url?.includes("hkex.com.hk/News/Market-Communications/")) {
    throw new Error(`Invalid HKEX processing statistic source/date: ${report.as_of}`);
  }
}
if (dashboard.official_processing_statistics?.[0]?.under_processing_total !== processingReports[0].under_processing_total) {
  throw new Error("Dashboard/snapshot HKEX processing statistic mismatch");
}

const futureDated = [
  ...snapshot.listings.map((row) => ["listing", row.hk_code, row.listing_date]),
  ...snapshot.active_applications.map((row) => ["active application", row.application_id, row.latest_document_date]),
  ...snapshot.application_history.map((row) => ["application history", row.application_id, row.latest_document_date]),
].filter(([, , value]) => value && value > snapshot.snapshot_date);
if (futureDated.length) throw new Error(`Rows dated after snapshot cutoff: ${JSON.stringify(futureDated.slice(0, 5))}`);

if (snapshot.quality?.source_freshness?.sse_universe_mode === "manual-official-export") {
  const exports = manifest.documents.filter((row) => row.cache_status === "manual-official-export");
  if (exports.length !== 2) throw new Error(`Expected two SSE official exports, found ${exports.length}`);
  if (exports.some((row) => row.source_as_of !== snapshot.snapshot_date)) throw new Error("SSE official export date mismatch");
  if (exports.reduce((sum, row) => sum + Number(row.record_count || 0), 0) < 2_000) throw new Error("SSE official export is incomplete");
}
if (snapshot.quality?.source_freshness?.szse_universe_mode === "reused-verified-no-change") {
  const verified = manifest.documents.filter((row) => row.cache_status === "reused-verified-no-change");
  if (verified.length !== 1 || verified[0].change_control_verified_through !== snapshot.snapshot_date) {
    throw new Error("SZSE change-control verification is missing or stale");
  }
}

const listingKeys = new Set();
for (const row of snapshot.listings) {
  const key = `${row.year}-${row.hk_code}`;
  if (listingKeys.has(key)) throw new Error(`Duplicate listing: ${key}`);
  listingKeys.add(key);
  const isAnnualReport = row.source_url.startsWith("https://www2.hkexnews.hk/");
  const isVerifiedGapFill = row.source_detail?.includes("HKEX实盘上市名录")
    && row.source_url.startsWith("https://www1.hkexnews.hk/listedco/listconews/")
    && row.source_url.endsWith(".pdf")
    && row.listing_date > snapshot.nlr_as_of?.[String(row.year)]
    && row.listing_date <= snapshot.quality?.source_freshness?.hkex_newly_listed_securities_as_of;
  if (!/^\d{5}$/.test(row.hk_code) || !row.company_name || !(isAnnualReport || isVerifiedGapFill)) throw new Error(`Invalid official listing row: ${key}`);
  if (row.original_document_url && !row.original_document_url.startsWith("https://www1.hkexnews.hk/listedco/listconews/")) throw new Error(`Invalid original prospectus link: ${key}`);
  if (row.ipo_classification !== "IPO" || row.excluded_from_ipo_statistics === true) throw new Error(`Non-IPO event leaked into IPO statistics: ${key}`);
  if (row.market === "主板") {
    if (Number(row.total_proceeds_hkd) === 0) throw new Error(`Zero-fundraising Main Board event leaked into IPO statistics: ${key}`);
    const recomputed = Number(row.public_offer_hkd) + Number(row.international_placing_hkd);
    if (!Number.isFinite(recomputed) || Math.abs(recomputed - Number(row.total_proceeds_hkd)) > 0.1) throw new Error(`Proceeds do not reconcile: ${key}`);
  } else if (!Number.isFinite(Number(row.total_proceeds_hkd))) throw new Error(`Invalid GEM proceeds: ${key}`);
}
const verifiedGapCodes = snapshot.listings.filter((row) => row.source_detail?.includes("HKEX实盘上市名录")).map((row) => row.hk_code).sort();
if (JSON.stringify(verifiedGapCodes) !== JSON.stringify([...(snapshot.quality?.source_freshness?.verified_post_nlr_listing_codes || [])].sort())) throw new Error("Live-listing gap-fill audit mismatch");
if (verifiedGapCodes.length && !manifest.documents.some((row) => row.url?.includes("Newly-Listed-Securities"))) throw new Error("HKEX live-listing source missing from manifest");
for (const code of verifiedGapCodes) {
  if (!manifest.documents.some((row) => row.url?.includes("/listedco/listconews/") && row.local_file?.includes(`/final-allotments/${code}-`))) throw new Error(`Final allotment source missing from manifest: ${code}`);
}
const originalProspectusCount = snapshot.listings.filter((row) => row.original_document_url).length;
if (originalProspectusCount !== snapshot.quality.official_listing_rows_with_original_prospectus) throw new Error("Original prospectus coverage mismatch");
if (originalProspectusCount / snapshot.listings.length < 0.9) throw new Error(`Original prospectus coverage below 90%: ${originalProspectusCount}/${snapshot.listings.length}`);
for (const row of snapshot.listings) {
  if (!["direct", "pending_verification", "unmatched"].includes(row.original_document_status)) throw new Error(`Invalid document status: ${row.hk_code}`);
  if ((row.original_document_status === "direct") !== Boolean(row.original_document_url)) throw new Error(`Document status/link mismatch: ${row.hk_code}`);
}
if (snapshot.quality.official_listing_documents_pending !== snapshot.listings.length - originalProspectusCount) throw new Error("Pending final-document count mismatch");
const expectedCorrectedDates = new Map([["2023-02469", "2022-12-23"], ["2021-09600", "2020-12-21"], ["2021-01855", "2020-12-22"]]);
for (const row of snapshot.listings) {
  const expected = expectedCorrectedDates.get(`${row.year}-${row.hk_code}`);
  if (expected && row.prospectus_date !== expected) throw new Error(`Prospectus date correction missing: ${row.hk_code}`);
}

const excludedCodes = new Set(snapshot.excluded_non_ipo_listings.map((row) => row.hk_code));
const requiredNonIpoCodes = [
  "07489", "02665", "06887", "06676", "02562", "09882", "00933", "09689", "06623", "02421",
  "09658", "03896", "02076", "01698", "06638", "02423", "00587", "06655", "09866", "02176",
  "02295", "03774", "06051", "06663", "09876", "09893",
];
for (const requiredCode of requiredNonIpoCodes) {
  if (!excludedCodes.has(requiredCode)) throw new Error(`Required non-IPO listing event missing from exclusion audit: ${requiredCode}`);
}
const allowedNonIpoClasses = new Set(["GEM转主板", "介绍上市", "De-SPAC继承公司", "非募资新上市"]);
for (const row of snapshot.excluded_non_ipo_listings) {
  if (!allowedNonIpoClasses.has(row.ipo_classification) || row.excluded_from_ipo_statistics !== true) throw new Error(`Invalid non-IPO classification: ${row.hk_code}`);
}

const activeIds = new Set();
for (const row of snapshot.active_applications) {
  if (!row.application_id || activeIds.has(row.application_id)) throw new Error(`Duplicate active application: ${row.application_id}`);
  activeIds.add(row.application_id);
  if (!row.company_name || !Array.isArray(row.documents)) throw new Error(`Invalid active application: ${row.application_id}`);
}

for (const row of [...snapshot.a_to_h_listed, ...snapshot.a_to_h_active]) {
  if (!["代码与公司名双重一致", "代码一致，名称近似", "官方更名记录核验"].includes(row.name_cross_check)) throw new Error(`A→H name verification failed: ${row.company_name}`);
  if (!/^\d{6}$/.test(row.a_code) || !["SSE", "SZSE"].includes(row.a_exchange)) throw new Error(`Unverified A-share identity: ${row.company_name}`);
  if (!row.a_official_url?.startsWith("https://www.s")) throw new Error(`Missing Mainland official evidence: ${row.company_name}`);
  if (!row.hk_official_url?.includes("hkexnews.hk")) throw new Error(`Missing HKEX official evidence: ${row.company_name}`);
}
for (const row of snapshot.a_to_h_listed) {
  if (!row.a_listing_date || row.a_listing_date >= row.hk_listing_date) throw new Error(`A→H listing chronology failed: ${row.company_name}`);
  if (!["代码与公司名双重一致", "代码一致，名称近似", "官方更名记录核验"].includes(row.name_cross_check)) throw new Error(`A→H name verification failed: ${row.company_name}`);
  if (!Array.isArray(row.sponsors) || row.sponsors.length === 0) throw new Error(`Missing listed A→H sponsors: ${row.company_name}`);
  if (!Number.isFinite(Number(row.hk_proceeds_hkd))) throw new Error(`Missing listed A→H proceeds: ${row.company_name}`);
  if (!row.hk_official_url?.startsWith("https://www1.hkexnews.hk/listedco/listconews/")) throw new Error(`Listed A→H source is not a company-level HKEXnews file: ${row.company_name}`);
}
if (!snapshot.a_to_h_exclusions?.some((row) => row.hk_code === "02315" && row.reason.includes("H→A"))) throw new Error("H→A exclusion audit missing");

const current = dashboard.year_summary.find((row) => row.year === dashboard.coverage.end_year);
const currentListings = snapshot.listings.filter((row) => row.year === snapshot.coverage.end_year);
if (!current || current.ipo_count !== currentListings.length) throw new Error("Current-year listing count mismatch");
if (Math.abs(current.proceeds_hkd - currentListings.reduce((sum, row) => sum + row.total_proceeds_hkd, 0)) > 0.1) throw new Error("Current-year proceeds mismatch");
for (const sponsor of dashboard.sponsor_listed_summary) {
  const projects = currentListings.filter((row) => row.sponsors.includes(sponsor.sponsor));
  const proceeds = projects.reduce((sum, row) => sum + row.total_proceeds_hkd, 0);
  if (projects.length !== sponsor.current_year_ipo_count || Math.abs(proceeds - sponsor.current_year_attributed_proceeds_hkd) > 0.1) throw new Error(`Sponsor totals do not reconcile: ${sponsor.sponsor}`);
}
const week = snapshot.weekly_activity;
if (!week || week.period_end >= snapshot.snapshot_date || week.period_start > week.period_end) throw new Error("Invalid calendar-week period");
if (week.listing_coverage_complete !== (week.listing_source_as_of >= week.period_end)) throw new Error("Weekly listing completeness label mismatch");
// A weekly release must cover every completed trading day before its snapshot.
// The annual NLR can lag behind HKEX's live listing notices while still being
// downloaded successfully. The collector may bridge that gap only through an
// overlapping trading list and individually verified final allotments.
const lastCompletedWeekday = new Date(`${snapshot.snapshot_date}T00:00:00Z`);
lastCompletedWeekday.setUTCDate(lastCompletedWeekday.getUTCDate() - 1);
while ([0, 6].includes(lastCompletedWeekday.getUTCDay())) {
  lastCompletedWeekday.setUTCDate(lastCompletedWeekday.getUTCDate() - 1);
}
const requiredListingAsOf = lastCompletedWeekday.toISOString().slice(0, 10);
if (week.listing_source_as_of < requiredListingAsOf) {
  throw new Error(`Verified HKEX listing sources are stale: ${week.listing_source_as_of}; expected through ${requiredListingAsOf} before publishing ${snapshot.snapshot_date}`);
}
const eventKeys = week.applications.map((row) => `${row.application_id}-${row.date}`);
if (new Set(eventKeys).size !== eventKeys.length || week.applications.some((row) => row.date < week.period_start || row.date > week.period_end)) throw new Error("Invalid weekly AP events");

for (const path of ["public/data/dashboard.json", "public/data/full_snapshot.json", "public/data/listed_ipos.csv", "public/data/excluded_non_ipo_listings.csv", "public/data/active_applications.csv", "public/data/a_to_h.csv"]) await access(join(root, path));
for (const [path, expected] of [["public/data/dashboard.json", dashboard], ["public/data/full_snapshot.json", snapshot]]) {
  if (JSON.stringify(await readJson(path)) !== JSON.stringify(expected)) throw new Error(`Public download differs from internal data: ${path}`);
}

const watch = await readJson("public/data/pipeline_watch.json");
const intelligence = await readJson("data/reference/pipeline_intelligence.json");
const researchIds = new Set(snapshot.research_active_applications.map(r=>r.application_id));
const conflictIds = new Set(snapshot.active_state_conflicts.flatMap(r=>r.active_application_ids));
if (snapshot.active_applications.some(r=>Number(researchIds.has(r.application_id))+Number(conflictIds.has(r.application_id))!==1)) throw new Error('Raw/research/conflict application sets do not reconcile');
if (JSON.stringify(snapshot.research_active_applications)!==JSON.stringify(dashboard.research_active_applications) || JSON.stringify(snapshot.research_a_to_h_active)!==JSON.stringify(dashboard.research_a_to_h_active)) throw new Error('Research download/dashboard mismatch');
if (snapshot.research_a_to_h_active.some(r=>!researchIds.has(r.application_id))) throw new Error('A/H research row excluded by terminal evidence');
const watchActiveIds = new Set(watch.rows.filter(r=>r.status==='public_active').flatMap(r=>r.active_application_ids));
if (watchActiveIds.size!==researchIds.size || [...researchIds].some(id=>!watchActiveIds.has(id))) throw new Error('Watch/research active sets differ');
for (const r of snapshot.active_state_conflicts) if (!r.events.some(e=>['terminated','denied'].includes(e.kind)) && !r.reason.includes('上市') && !r.reason.includes('拒绝')) throw new Error('Exclusion lacks terminal basis');
await access(join(root,'public/data/research_active_applications.csv'));
const ahCsv = await readFile(join(root,'public/data/a_to_h.csv'),'utf8');
for (const row of snapshot.a_to_h_active.filter(r=>conflictIds.has(r.application_id))) if (ahCsv.includes(row.company_name)) throw new Error('A/H CSV still includes a terminal-evidence conflict');
if (watch.official_snapshot_date !== snapshot.snapshot_date || watch.evidence_reviewed_at !== intelligence.reviewed_at) throw new Error("Watch evidence/base dates do not match");
if (snapshot.pipeline_watch && JSON.stringify(snapshot.pipeline_watch) !== JSON.stringify(watch)) throw new Error("Watch layer differs from full snapshot");
const companyKey = value => value.normalize("NFKC").toLowerCase().replace(/\s*\((?:前称为?|前稱為?|曾用名|formerly).*\)\s*$/, "").replace(/(?:\s*[-—–]\s*(?:h\s*股|[bpswz]{1,3}))+\s*$/, "").replace(/[\s()（）,，.。·•\-—–]/g, "");
const excludedWatchNames = new Set([...snapshot.listings, ...snapshot.excluded_non_ipo_listings].map(r => companyKey(r.company_name)));
const watchIds = new Set();
const watchCounts = {};
for (const row of watch.rows) {
  if (watchIds.has(row.id) || excludedWatchNames.has(companyKey(row.company_name))) throw new Error(`Duplicate/listed pipeline company: ${row.company_name}`);
  watchIds.add(row.id);
  if (!watch.labels[row.status] || watch.labels[row.status] !== row.status_label) throw new Error("Invalid watch category");
  watchCounts[row.status] = (watchCounts[row.status] || 0) + 1;
  if (row.is_a_to_h !== Boolean(row.a_code && row.a_official_url)) throw new Error("Invalid watch A-share identity");
  if ((row.status.includes("continuing") || row.status.startsWith("confidential_")) && !row.events.length) throw new Error("Evidence required for asserted pipeline status");
  if (row.bucket === "public" && row.status !== "public_active" && (!row.last_prospectus_update_date || row.last_prospectus_update_date < watch.public_filing_start_date || row.last_prospectus_update_date < watch.public_update_cutoff)) throw new Error("Public reserve outside 12-month prospectus window");
  if (row.bucket === "confidential") {
    const evidence = row.classification_source;
    if (!evidence || !row.events.some(e => e.url === evidence.url && e.date === evidence.date) || !watch.confidential_tier_labels[row.confidential_tier]) throw new Error("Confidential row lacks dated classification source");
    const tier1 = evidence.kind === "confidential_confirmed" || (evidence.kind === "confidential_reported" && evidence.source_tier === "authoritative");
    if (row.confidential_tier !== (tier1 ? "tier1" : "tier2")) throw new Error("Confidential evidence tier mismatch");
  }
  if (row.bucket !== (row.status.startsWith("confidential_") ? "confidential" : "public")) throw new Error("Invalid two-bucket assignment");
  if (row.status === "public_active" && !snapshot.active_applications.some(a => companyKey(a.company_name) === companyKey(row.company_name))) throw new Error("Active pipeline row lacks current public record");
  if (row.status === "lapsed_continuing" && !row.events.some(e => e.kind === "continuing" && ["issuer", "regulator"].includes(e.level) && e.date >= row.estimated_lapse_date)) throw new Error("Continuing status lacks post-lapse primary evidence");
  for (const event of row.events) {
    if (!/^https:\/\//.test(event.url) || event.date > watch.evidence_reviewed_at) throw new Error("Invalid evidence link/date");
  }
}
for (const key of Object.keys(watch.labels)) if ((watch.counts[key] || 0) !== (watchCounts[key] || 0)) throw new Error("Watch counts do not reconcile");
for (const key of ["public", "confidential"]) if ((watch.bucket_counts[key] || 0) !== watch.rows.filter(r => r.bucket === key).length) throw new Error("Pipeline bucket counts do not reconcile");
for (const key of ["tier1", "tier2"]) if ((watch.confidential_tier_counts[key] || 0) !== watch.rows.filter(r => r.confidential_tier === key).length) throw new Error("Confidential tiers do not reconcile");
for (const path of ["public/data/pipeline_watch.csv", "public/data/a_to_h_watch.csv"]) await access(join(root, path));
const analytics = await readJson('public/data/pipeline_analytics.json');
if (analytics.official_snapshot_date !== snapshot.snapshot_date || analytics.watch_as_of !== watch.generated_as_of || analytics.evidence_reviewed_at !== watch.evidence_reviewed_at) throw new Error('Pipeline analytics dates differ');
if (new Set(analytics.rows.map(r=>r.id)).size !== watch.rows.length || analytics.rows.length !== watch.rows.length) throw new Error('Analytics universe mismatch');
for (const row of analytics.rows) {
  const original = watch.rows.find(r=>r.id===row.id);
  if (!original || row.status!==original.status || row.a_code!==original.a_code || row.confidential_tier!==original.confidential_tier) throw new Error('Analytics changed evidence classification');
  if (row.a_market_cap_rmb_bn != null) {
    if (!(row.a_market_cap_rmb_bn > 0) || !row.market_data_date || !row.market_data_source_url) throw new Error('Market value lacks dated source');
    const h = row.a_market_cap_rmb_bn * .643, base = h*.1;
    if (Math.abs(row.estimated_h_valuation_rmb_bn-h)>.011 || Math.abs(row.estimated_base_issue_rmb_bn-base)>.011 || Math.abs(row.estimated_max_issue_rmb_bn-base*1.15)>.011) throw new Error('Scenario arithmetic mismatch');
  } else if ([row.estimated_h_valuation_rmb_bn,row.estimated_base_issue_rmb_bn,row.estimated_max_issue_rmb_bn].some(v=>v!=null)) throw new Error('Missing market data must not yield modeled figures');
  if (row.category==='active') {
    const current=snapshot.research_active_applications.find(r=>r.application_id===row.application_id);
    if (!current || JSON.stringify(current.sponsors)!==JSON.stringify(row.sponsors)) throw new Error('Analytics current fields must come from current research application');
  }
  if (row.category==='confidential' && row.sponsors.length) throw new Error('Unverified confidential sponsor attribution');
}
console.log(`Validation passed: ${snapshot.listings.length} listings, ${snapshot.application_history.length} application-history rows, ${snapshot.active_applications.length} active applications, ${snapshot.a_to_h_listed.length + snapshot.a_to_h_active.length} verified A→H rows; ${watch.rows.length} separately labelled watch companies.`);
