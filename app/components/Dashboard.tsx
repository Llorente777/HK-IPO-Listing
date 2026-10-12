"use client";
import { SourceLink, LinkAuditSummary } from './SourceLink';

import { useMemo, useState, useSyncExternalStore } from "react";
import { currentRoute, serverRoute, subscribeRoute, readRoute, routeHash } from '@/lib/site-navigation';
import { IpoStatistics, PipelineStatistics } from './ResearchStatistics';
import { exportUrl } from '@/lib/export-url';
import { applicationScopeNote } from '@/lib/application-scope';
import { groupApplications } from "@/lib/application-groups";
import { ScopeComparison } from './ScopeComparison';
import { PipelineExplorer, PipelineOverview, SponsorProjects } from './PipelineExplorer';
import dashboard from "@/data/processed/dashboard.json";
import { PipelineWatch, PipelineNavigation, watchRows } from "./PipelineWatch";
import { ahMarketCapOrder, rankActiveAhByPredictedIssue, rankListedAhSponsors, rankSponsorsByProceeds, summarizeActiveAh, summarizeListedAh } from "@/lib/metrics";

type Tab = "home" | "ipo" | "applications" | "ah" | "sponsors" | "methodology";
type Listing = (typeof dashboard.listings)[number];
type Application = (typeof dashboard.research_active_applications)[number];

const navigation: { id: Tab; label: string }[] = [
  { id: "home", label: "IPO总览" },
  { id: "ipo", label: "上市数据库" },
  { id: "applications", label: "递表与在审" },
  { id: "ah", label: "A→H专题" },
  { id: "sponsors", label: "保荐机构" },
  { id: "methodology", label: "口径与来源" },
];

const n = (value: number | null | undefined, digits = 0) => value == null ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const hkdBn = (value: number | null | undefined) => value == null ? "—" : `HK$${n(value / 1_000_000_000, 2)}bn`;
const rmbBn = (value: number | null | undefined) => value == null ? "—" : `RMB ${n(value, 2)}bn`;
const compactName = (value: string) => value.replace(/\s*-\s*[BPSW](\s*-\s*H\s*股)?/gi, "").replace(/\s*-\s*H\s*股/gi, "").trim();
const sourceDate = dashboard.snapshot_date;

function ExternalIcon() { return <span aria-hidden="true">↗</span>; }

export function Dashboard() {
  const hash=useSyncExternalStore(subscribeRoute,currentRoute,serverRoute);
  const route=readRoute(hash),tab=route.tab,selectedFilter=route.q;
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = (next: Tab, searchFilter = "", section = "") => {
    window.location.hash=routeHash(next,searchFilter,section);
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const matches = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [];
    const listings = dashboard.listings.filter((item) => `${item.hk_code}${item.company_name} ${dashboard.a_to_h_listed.find(a=>a.hk_code===item.hk_code)?.a_code||''}`.toLowerCase().includes(keyword)).slice(0, 4).map((item) => ({ kind: "上市", name: item.company_name, code: item.hk_code, target: "ipo" as Tab }));
    const applications = dashboard.research_active_applications.filter((item) => `${item.company_name} ${item.application_id} ${dashboard.research_a_to_h_active.find(a => a.application_id === item.application_id)?.a_code || ""}`.toLowerCase().includes(keyword)).slice(0, 4).map((item) => ({ kind: "申请", name: item.company_name, code: item.application_id, target: "applications" as Tab }));
    const watch = watchRows.filter((item) => item.status !== "public_active" && `${item.company_name}${item.a_code || ""}${item.aliases.join(" ")}`.toLowerCase().includes(keyword)).slice(0, 3).map(item => ({ kind: "储备", name: item.company_name, code: item.a_code || "非公开有效申请", target: "applications" as Tab }));
    return [...listings, ...applications, ...watch].slice(0, 7);
  }, [query]);

  return <main className="current-site">
    <header className="topbar">
      <button className="brand" onClick={() => navigate("home")} aria-label="返回IPO总览"><span className="brand-mark">港</span><span><b>港股IPO情况汇总</b><small>HK IPO WEEKLY DATABASE</small></span></button>
      <nav className={menuOpen ? "open" : ""} aria-label="主导航">{navigation.map((item) => <button className={tab === item.id ? "active" : ""} key={item.id} onClick={() => navigate(item.id)}>{item.label}</button>)}</nav>
      <div className="search-wrap"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={e=>{if(e.key==='Escape')setQuery('');if(e.key==='Enter'&&matches[0]){const m=matches[0];navigate(m.target,m.target==='ipo'?m.code:m.name);setQuery('');}}} placeholder="公司 / 代码" aria-label="搜索公司或代码" /></div>
      <button className="menu" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-label={menuOpen?'收起导航':'打开导航'}>☰</button>
      {query.trim() && matches.length === 0 && <div className="search-results"><p>未找到匹配公司或代码</p></div>}
      {matches.length > 0 && <div className="search-results">{matches.map((item) => <button key={`${item.kind}-${item.code}-${item.name}`} onClick={() => { navigate(item.target, item.target === "ipo" ? item.code : item.name); setQuery(""); }}><b>{compactName(item.name)}</b><span>{item.kind} · {item.code}</span></button>)}</div>}
    </header>

    {tab === "home" && <HomeView navigate={navigate} />}
    {tab === "ipo" && <IpoView key={selectedFilter} initialFilter={selectedFilter} />}
    {tab === "applications" && <ApplicationsView key={`${selectedFilter}-${route.section}`} initialFilter={selectedFilter} initialPanel={route.section} />}
    {tab === "ah" && <AhView key={route.section} initialSection={route.section} />}
    {tab === "sponsors" && <SponsorsView />}
    {tab === "methodology" && <MethodologyView />}

    <footer><div><span className="brand-mark small">港</span><b>港股IPO情况汇总</b><SourceLink className="archive-link" href="/versions/v23">第23版历史样例 ↗</SourceLink><SourceLink className="archive-link" href="/versions/v22">第22版历史样例 ↗</SourceLink><button className="text-action" onClick={()=>window.scrollTo({top:0,behavior:'smooth'})}>返回顶部 ↑</button></div><p>官方事实来自 HKEX/HKEXnews、上交所及深交所。模型字段均单独标注；Excel 仅用于首次历史映射及统计维度参考，周度更新无需再次上传。仅供信息参考，不构成投资、法律或监管意见。</p></footer>
  </main>;
}

function HomeView({ navigate }: { navigate: (tab: Tab,q?:string,section?:string) => void }) {
  const current = dashboard.current_year!;
  const stats = dashboard.statistics;
  const activeScope = dashboard.active_application_scope;
  const processing = dashboard.official_processing_statistics[0];
  const previousProcessing = dashboard.official_processing_statistics[1];
  const processingChange = previousProcessing ? processing.under_processing_total - previousProcessing.under_processing_total : null;
  const weekly = dashboard.weekly_activity;
  const weeklyNewListings = weekly.listings as readonly Listing[];
  const topDeals = [...dashboard.latest_listings].sort((a, b) => b.total_proceeds_hkd - a.total_proceeds_hkd).slice(0, 8);
  const maxProceeds = Math.max(...dashboard.year_summary.map((item) => item.proceeds_hkd_bn));
  return <>
    <section className="hero">
      <div className="hero-grid">
        <div><p className="eyebrow gold-text">HK CAPITAL MARKETS INTELLIGENCE</p><h1>港股IPO情况汇总</h1><p className="lead">覆盖港交所新上市、监管处理中申请、HKEXnews公开AP/PHIP、A→H交叉核验及保荐机构项目。官方数据每周自动更新，保留完整历史快照。</p><div className="hero-actions"><button className="primary" onClick={() => navigate("ipo")}>查看上市数据库 →</button><button className="ghost" onClick={() => navigate("applications")}>查看申请与储备 →</button></div></div>
        <aside className="snapshot-card"><div className="snapshot-head"><span><i className="status" /> 官方周度快照</span><small>SCHEMA {dashboard.schema_version}</small></div><h2>{current.year}年周度快照 · {sourceDate}</h2><div className="snapshot-kpis"><div><strong>{current.ipo_count}</strong><span>募资型IPO · 报告截至 {current.source_as_of}</span></div><div><strong>{n(current.proceeds_hkd_bn, 2)}</strong><span>募资 / HK$bn</span></div><div><strong>{dashboard.active_application_count}</strong><span>HKEXnews公开记录</span></div><div><strong>{dashboard.research_a_to_h_active.length}</strong><span>A→H申请</span></div></div><SourceLink className="download-dark" href="/data/full_snapshot.json" download>下载完整数据库 ↓</SourceLink></aside>
      </div>
      <div className="source-strip"><span>生产来源</span>{dashboard.official_sources.map((source) => <SourceLink key={source.label} href={source.url} target="_blank" rel="noreferrer">{source.label} <ExternalIcon /></SourceLink>)}</div>
    </section>

    <section className="section light">
      <SectionHead eyebrow="MARKET AT A GLANCE" title="市场总览" text={`${dashboard.coverage.start_year}–${dashboard.coverage.end_year} 全量回填；介绍上市、GEM转板、De-SPAC继承公司及其他零募资事件均从IPO统计排除，并保留审计清单。`} />
      <div className="kpi-grid">
        <Metric label="年内募资型IPO" value={`${current.ipo_count} 家`} note={`主板 ${stats.listings.main_board_count} · GEM ${stats.listings.gem_count}`} onClick={() => navigate("ipo")} />
        <Metric label="年内募资总额" value={`HK$${n(current.proceeds_hkd_bn, 2)}bn`} note={`平均 ${n(stats.listings.average_proceeds_hkd_bn, 2)} · 中位 ${n(stats.listings.median_proceeds_hkd_bn, 2)} bn`} onClick={() => navigate("ipo")} />
        <Metric label="港交所月报审核处理中" value={`${processing.under_processing_total} 宗`} note={`截至 ${processing.as_of}${processingChange == null ? "" : ` · 较上月 ${processingChange >= 0 ? "+" : ""}${processingChange}`}`} onClick={() => navigate("methodology")} />
        <Metric label="HKEXnews公开申请记录" value={`${dashboard.active_application_count} 宗`} note={`${activeScope.unique_company_names} 家公司 · AP ${stats.applications.ap_count} · PHIP ${stats.applications.phip_count}`} onClick={() => navigate("applications")} />
        <Metric label="同一ID多轮递表" value={`${stats.applications.multiple_round_count} 宗`} note={`公开记录中位 ${stats.applications.median_age_days} 天`} onClick={() => navigate("applications",'',"multi")} />
        <Metric label="当前A→H申请" value={`${dashboard.research_a_to_h_active.length} 家`} note="官方索引 × 沪深名录，排除已核实终止项目" onClick={() => navigate("ah")} />
        <Metric label="历史A→H上市" value={`${dashboard.a_to_h_listed.length} 家`} note={`年内 ${current.a_to_h_count} 家 · 占比 ${current.a_to_h_share_pct}%`} onClick={() => navigate("ah",'',"listed")} />
        <Metric label="公开申请保荐人覆盖" value={`${stats.applications.sponsor_coverage_count}/${dashboard.active_application_count}`} note="逐份AP参与方章节解析" onClick={() => navigate("applications",'',"sponsors")} />
      </div>
    </section>

    <section className="section weekly-section">
      <div className="split-heading"><SectionHead eyebrow="WEEKLY CHANGE LOG" title="本周信息更新" text={`上一个完整自然周：${weekly.period_start} 至 ${weekly.period_end}。上市报告截至 ${weekly.listing_source_as_of}；${weekly.listing_coverage_complete ? "已覆盖完整周" : "尚未覆盖完整周，上市数待报告补齐"}。`} /><span className="weekly-badge">自然周事件 · 快照变更分列</span></div>
      <div className="weekly-grid">
        <article><div className="weekly-count"><span>上周上市（已披露）</span><strong>{weekly.listing_coverage_complete ? weeklyNewListings.length : `≥${weeklyNewListings.length}`}</strong><small>家</small></div><div className="weekly-names">{weeklyNewListings.length ? weeklyNewListings.map((item) => <p key={item.hk_code}><b>{compactName(item.company_name)}</b><span>{item.hk_code} · {item.listing_date || "日期待报告披露"}</span></p>) : <p className="empty-week">{weekly.listing_coverage_complete ? "上周无募资型IPO上市" : "暂无已披露记录，不能认定上周为零家"}</p>}</div></article>
        <article><div className="weekly-count"><span>上周公开递表</span><strong>{weekly.application_company_count}</strong><small>家公司 / {weekly.applications.length} 宗记录</small></div><div className="weekly-names">{weekly.applications.length ? weekly.applications.map((item) => <p key={`${item.application_id}-${item.date}`}><b>{item.company_name}</b><span>{item.date} · AP {item.source_url && <SourceLink href={item.source_url} target="_blank" rel="noreferrer">原文件 ↗</SourceLink>}</span></p>) : <p className="empty-week">上周无公开AP递表记录</p>}</div></article>
        <article><div className="weekly-count"><span>快照间移出当前索引</span><strong>{dashboard.weekly_changes.removed_active_applications.length}</strong><small>宗</small></div><div className="weekly-names">{dashboard.weekly_changes.removed_active_applications.length ? dashboard.weekly_changes.removed_active_applications.map((item) => <p key={item.application_id}><b>{item.company_name}</b><span>上一阶段 {item.has_phip ? "PHIP" : "AP"}</span></p>) : <p className="empty-week">本期无移出记录</p>}</div></article>
      </div>
      <p className="table-note">递表按AP文件披露日统计，合并当前及历史索引，按申请ID＋日期去重；PHIP和协调人公告不算新递表。移出索引另按 {dashboard.weekly_changes.comparison_from} 至 {dashboard.weekly_changes.comparison_to} 两次快照比较，不推断具体原因。</p>
    </section>

    <section className="section paper-alt">
      <div className="split-heading"><SectionHead eyebrow="SIX-YEAR BACKFILL" title="六年港股IPO走势" text="家数、募资额与A→H数量来自港交所年度新上市报告。" /><SourceLink className="outline-button" href="/data/listed_ipos.csv" download>下载上市明细 ↓</SourceLink></div>
      <div className="year-grid">{dashboard.year_summary.map((item) => <article key={item.year}><div className="year-title"><b>{item.year}</b><span>截至 {item.source_as_of}</span></div><strong>HK${n(item.proceeds_hkd_bn, 2)}bn</strong><p>{item.ipo_count} 家IPO · A→H {item.a_to_h_count} 家</p><div className="bar"><i style={{ width: `${Math.max(3, item.proceeds_hkd_bn / maxProceeds * 100)}%` }} /></div></article>)}</div>
    </section>

    <section className="section light two-panel">
      <div className="panel"><div className="panel-head"><div><p className="eyebrow">TOP DEALS</p><h2>年内募资规模前列</h2></div><button onClick={() => navigate("ipo")}>全部项目 →</button></div><div className="rank-list">{topDeals.map((item, index) => <div key={item.hk_code}><span>{String(index + 1).padStart(2, "0")}</span><p><b>{compactName(item.company_name)}</b><small>{item.hk_code} · {item.listing_date} · {item.market}</small></p><strong>{hkdBn(item.total_proceeds_hkd)}</strong></div>)}</div></div>
      <div className="panel"><div className="panel-head"><div><p className="eyebrow">APPLICATION PIPELINE</p><h2>HKEXnews当前AP / PHIP结构</h2></div><button onClick={() => navigate("applications")}>进入数据库 →</button></div><div className="structure-list"><div><span>仅AP记录</span><b>{stats.applications.ap_count}</b><i><em style={{ width: `${stats.applications.ap_count / dashboard.active_application_count * 100}%` }} /></i></div><div><span>PHIP记录</span><b>{stats.applications.phip_count}</b><i><em style={{ width: `${stats.applications.phip_count / dashboard.active_application_count * 100}%` }} /></i></div><div><span>同一ID多轮</span><b>{stats.applications.multiple_round_count}</b><i><em style={{ width: `${stats.applications.multiple_round_count / dashboard.active_application_count * 100}%` }} /></i></div><div><span>主板记录</span><b>{stats.applications.main_board_count}</b><i><em style={{ width: `${stats.applications.main_board_count / dashboard.active_application_count * 100}%` }} /></i></div></div><div className="notice"><i className="status" /><p><b>按港交所当前索引、申请ID去重</b><span>{dashboard.active_application_count} 宗记录对应 {activeScope.unique_company_names} 家标准化公司；同一公司不同申请ID分别保留。</span></p></div></div>
    </section>
  </>;
}

function IpoView({ initialFilter = "" }: { initialFilter?: string }) {
  const [view,setView]=useState('details');
  const [page,setPage]=useState(0);
  const [filter, setFilter] = useState(initialFilter);
  const [year, setYear] = useState(initialFilter ? "全部" : String(dashboard.coverage.end_year));
  const [market, setMarket] = useState("全部");
  const [proceedsBand, setProceedsBand] = useState("全部");
  const [hShare, setHShare] = useState("全部");
  const [sponsor, setSponsor] = useState("全部");
  const sponsorOptions = useMemo(() => [...new Set(dashboard.listings.flatMap((item) => item.sponsors))].sort((a, b) => a.localeCompare(b, "zh-CN")), []);
  const rows = useMemo(() => dashboard.listings.filter((item) => {
    const proceedsBn = item.total_proceeds_hkd / 1_000_000_000;
    const matchesProceeds = proceedsBand === "全部"
      || (proceedsBand === "10亿以下" && proceedsBn < 1)
      || (proceedsBand === "10–50亿" && proceedsBn >= 1 && proceedsBn < 5)
      || (proceedsBand === "50–100亿" && proceedsBn >= 5 && proceedsBn < 10)
      || (proceedsBand === "100亿以上" && proceedsBn >= 10);
    return (year === "全部" || String(item.year) === year)
      && (market === "全部" || item.market === market)
      && matchesProceeds
      && (hShare === "全部" || (hShare === "H股" ? item.is_h_share_name : !item.is_h_share_name))
      && (sponsor === "全部" || (item.sponsors as readonly string[]).includes(sponsor))
      && `${item.hk_code}${item.company_name}${item.sponsors.join("")}${item.reporting_accountant || ""} ${dashboard.a_to_h_listed.find(a=>a.hk_code===item.hk_code)?.a_code||''}`.toLowerCase().includes(filter.trim().toLowerCase());
  }), [filter, year, market, proceedsBand, hShare, sponsor]);
  const proceeds = rows.reduce((sum, item) => sum + item.total_proceeds_hkd, 0);
  const filterKey=JSON.stringify([filter,year,market,proceedsBand,hShare,sponsor]);
  const [previousFilters,setPreviousFilters]=useState(filterKey);
  if(previousFilters!==filterKey){setPreviousFilters(filterKey);setPage(0);}
  return <PageShell eyebrow="HKEX OFFICIAL NEW LISTING REPORTS" title="港股上市数据库" text={`覆盖 ${dashboard.coverage.start_year}–${dashboard.coverage.end_year} 主板及 GEM 募资型IPO；已排除 ${dashboard.coverage.non_ipo_listing_records_excluded} 条非IPO上市事件。当前筛选 ${rows.length} 家，募资 ${hkdBn(proceeds)}。`}>
    <DataToolbar filter={filter} setFilter={setFilter}>
      <label>上市年份<select value={year} onChange={(event) => setYear(event.target.value)}><option>全部</option>{dashboard.year_summary.map((item) => <option key={item.year}>{item.year}</option>)}</select></label>
      <label>上市市场<select value={market} onChange={(event) => setMarket(event.target.value)}><option>全部</option><option>主板</option><option>GEM</option></select></label>
      <label>募资规模（HK$）<select value={proceedsBand} onChange={(event) => setProceedsBand(event.target.value)}><option>全部</option><option>10亿以下</option><option>10–50亿</option><option>50–100亿</option><option>100亿以上</option></select></label>
      <label>股份属性<select value={hShare} onChange={(event) => setHShare(event.target.value)}><option>全部</option><option>H股</option><option>非H股</option></select></label>
      <label>保荐机构<select value={sponsor} onChange={(event) => setSponsor(event.target.value)}><option>全部</option>{sponsorOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
      <button className="filter-reset" onClick={() => { setFilter(""); setYear(String(dashboard.coverage.end_year)); setMarket("全部"); setProceedsBand("全部"); setHShare("全部"); setSponsor("全部"); }}>重置筛选</button>
      <SourceLink className="outline-button" href={exportUrl("ipo",rows.map(r=>dashboard.listings.indexOf(r)))} download>下载当前筛选 CSV ↓</SourceLink><DownloadLinks primary="/data/listed_ipos.csv" />
    </DataToolbar>
    <div className="content-view-switch"><button aria-pressed={view==='details'} onClick={()=>setView('details')}>公司明细</button><button aria-pressed={view==='analysis'} onClick={()=>setView('analysis')}>统计与趋势</button></div>
    <IpoStatistics rows={rows} expanded={view==='analysis'} />
    {view==='details'&&<><TableWrap><table><thead><tr><th>上市文件日</th><th>上市日</th><th>代码 / 公司</th><th>市场</th><th>发售价</th><th>香港发售</th><th>国际配售</th><th>募资总额</th><th>保荐人</th><th>申报会计师</th><th>物业估值师</th><th>官方原文件 / 统计依据</th></tr></thead><tbody>{rows.slice(page*25,(page+1)*25).map((item) => <tr key={`${item.year}-${item.hk_code}`}><td>{item.prospectus_date || "—"}</td><td>{item.listing_date || "—"}</td><td className="company-cell"><b>{compactName(item.company_name)}</b><small>{item.hk_code}{item.is_h_share_name ? " · H股" : ""}</small></td><td><span className="pill">{item.market}</span></td><td>{item.offer_price_hkd == null ? "—" : `HK$${n(item.offer_price_hkd, 2)}`}</td><td>{hkdBn(item.public_offer_hkd)}</td><td>{hkdBn(item.international_placing_hkd)}</td><td><b>{hkdBn(item.total_proceeds_hkd)}</b></td><td className="wide-cell">{item.sponsors.join(" / ") || "—"}</td><td>{item.reporting_accountant || "—"}</td><td>{item.property_valuer || "—"}</td><td>{item.original_document_url ? <SourceLink href={item.original_document_url} target="_blank" rel="noreferrer">{item.original_document_title?.includes("招股") ? "招股章程" : "官方上市文件"} <ExternalIcon /></SourceLink> : <span className="source-fallback" title={item.original_document_unavailable_reason || undefined}>{item.original_document_status === "pending_verification" ? "最终文件待核验" : "原文件待匹配"}</span>}<SourceLink href={item.source_url} target="_blank" rel="noreferrer">{item.source_url.toLowerCase().endsWith(".pdf") ? "公司配发结果" : "年度汇总表"} <ExternalIcon /></SourceLink></td></tr>)}</tbody></table></TableWrap>
    {!rows.length&&<p role="status">暂无符合筛选条件的IPO。</p>}<div className="watch-pagination"><button disabled={page===0} onClick={()=>setPage(page-1)}>上一页</button><span>{page+1} / {Math.max(1,Math.ceil(rows.length/25))} · 每页25家</span><button disabled={(page+1)*25>=rows.length} onClick={()=>setPage(page+1)}>下一页</button></div></>}
    <p className="table-note">公司级链接直达港交所披露易最终上市文件；“年度汇总表”或经核验的“公司配发结果”是发行条款依据；配发结果按绿鞋前最终发售股数计算，超额分配不等于绿鞋已行使。尚未核实的最终文件标为待核验，不等于文件未公开，也不计入直链覆盖率。上市文件日为官方披露日。</p>
  </PageShell>;
}

export function ApplicationsView({ initialFilter = "",initialPanel='' }: { initialFilter?: string;initialPanel?:string }) {
  const [panel, setPanel] = useState(initialPanel==='sponsors'?'sponsors':'companies');
  const [section, setSection] = useState(() => {
    const hit = initialFilter && watchRows.find(r => r.status !== "public_active" && r.company_name === initialFilter);
    return hit ? hit.bucket === "confidential" ? "confidential" : "reserve" : "active";
  });
  const [filter, setFilter] = useState(initialFilter);
  const [mode, setMode] = useState("全部");
  const [market, setMarket] = useState("全部");
  const [rounds, setRounds] = useState(initialPanel==='multi'?"多轮":"全部");
  const [age, setAge] = useState("全部");
  const [sponsor, setSponsor] = useState("全部");
  const sponsorOptions = useMemo(() => [...new Set(dashboard.research_active_applications.flatMap((item) => item.sponsors))].sort((a, b) => a.localeCompare(b, "zh-CN")), []);
  const rows = useMemo(() => dashboard.research_active_applications.filter((item) => {
    const ageDays = item.application_age_days ?? 0;
    const matchesAge = age === "全部"
      || (age === "90天以内" && ageDays <= 90)
      || (age === "91–180天" && ageDays > 90 && ageDays <= 180)
      || (age === "180天以上" && ageDays > 180);
    return (mode === "全部" || (mode === "PHIP" ? item.has_phip : !item.has_phip))
      && (market === "全部" || item.market === market)
      && (rounds === "全部" || (rounds === "多轮" ? item.application_rounds > 1 : item.application_rounds <= 1))
      && matchesAge
      && (sponsor === "全部" || (item.sponsors as readonly string[]).includes(sponsor))
      && `${item.company_name} ${item.application_id} ${dashboard.research_a_to_h_active.find(a=>a.application_id===item.application_id)?.a_code||''} ${item.sponsors.join(" ")}`.toLowerCase().includes(filter.trim().toLowerCase());
  }), [filter, mode, market, rounds, age, sponsor]);
  const companyRows = useMemo(() => groupApplications(rows), [rows]);
  const [page, setPage] = useState(0);
  const filterKey=JSON.stringify([filter,mode,market,rounds,age,sponsor]);
  const [previousFilters,setPreviousFilters]=useState(filterKey);
  if(previousFilters!==filterKey){setPreviousFilters(filterKey);setPage(0);}
  const pageRows = companyRows.slice(page * 25, (page + 1) * 25);
  return <PageShell eyebrow="APPLICATION PROOF & PHIP" title="递表与在审" text="核验后公开申请、历史递表储备与密交储备分表展示，按公司去重；储备项目不等于港交所正在审核的申请。">
    <ScopeComparison />
    <PipelineOverview onSelect={setSection} />
    <PipelineNavigation value={section} onChange={setSection} />
    <PipelineStatistics category={section} />
    <div className="content-view-switch"><button aria-pressed={panel==='companies'} onClick={()=>setPanel('companies')}>公司清单</button><button aria-pressed={panel==='sponsors'} onClick={()=>setPanel('sponsors')}>保荐机构与项目明细</button></div>
    {panel === 'sponsors' ? <SponsorProjects key={section} category={section} /> : section === 'all' ? <PipelineExplorer category="all" initialFilter={initialFilter} /> : section !== "active" ? <PipelineWatch key={section} category={section === "confidential" ? "confidential" : "public"} initialFilter={initialFilter} /> : <>
    <div className="view-context"><h2>核验后公开申请明细</h2><span>{applicationScopeNote()} · 筛选结果 {companyRows.length} 家 · 同一公司合并展示，申请ID保留在记录详情中</span></div>
    <DataToolbar filter={filter} setFilter={setFilter}>
      <label>申请阶段<select value={mode} onChange={(event) => setMode(event.target.value)}><option>全部</option><option>AP</option><option>PHIP</option></select></label>
      <label>申请市场<select value={market} onChange={(event) => setMarket(event.target.value)}><option>全部</option><option>主板</option><option>GEM</option></select></label>
      <label>同一ID递表轮次<select value={rounds} onChange={(event) => setRounds(event.target.value)}><option>全部</option><option>单轮</option><option>多轮</option></select></label>
      <label>记录距快照日天数<select value={age} onChange={(event) => setAge(event.target.value)}><option>全部</option><option>90天以内</option><option>91–180天</option><option>180天以上</option></select></label>
      <label>保荐机构<select value={sponsor} onChange={(event) => setSponsor(event.target.value)}><option>全部</option>{sponsorOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
      <button className="filter-reset" onClick={() => { setFilter(""); setMode("全部"); setMarket("全部"); setRounds("全部"); setAge("全部"); setSponsor("全部"); }}>重置筛选</button>
      <SourceLink className="outline-button" href={exportUrl("applications",rows.map(r=>dashboard.research_active_applications.indexOf(r)))} download>下载当前筛选 CSV ↓</SourceLink><DownloadLinks primary="/data/research_active_applications.csv" />
    </DataToolbar>
    <TableWrap><table><thead><tr><th>公司</th><th>市场 / 阶段</th><th>最新文件日</th><th>本申请起始日</th><th>保荐人</th><th>官方文件</th><th>记录详情</th></tr></thead><tbody>{pageRows.map(({id, latest: item, records}) => <tr key={id}><td className="company-cell"><b>{item.company_name}</b></td><td>{item.market}<small>{item.has_phip ? "PHIP" : "AP"}</small></td><td>{item.latest_document_date || "—"}</td><td>{item.first_document_date || "—"}</td><td className="wide-cell">{item.sponsors.join(" / ") || "待解析"}</td><td>{officialApplicationLink(item) ? <SourceLink href={officialApplicationLink(item)!} target="_blank" rel="noreferrer">HKEXnews ↗</SourceLink> : "—"}</td><td><details className="row-details"><summary>{records.length > 1 ? `${records.length} 个申请ID` : "查看"}</summary>{records.map(record => <div key={record.application_id}><b>ID {record.application_id}</b><small>{record.latest_document_date} · {record.has_phip ? "PHIP" : "AP"} · {record.document_count} 份文件</small><small>同一ID递表 {record.application_rounds || 1} 轮 · 记录时长 {record.application_age_days ?? "—"} 天</small>{officialApplicationLink(record) && <SourceLink href={officialApplicationLink(record)!} target="_blank" rel="noreferrer">该申请官方文件 ↗</SourceLink>}</div>)}</details></td></tr>)}{!pageRows.length && <tr><td colSpan={7}>暂无符合筛选条件的公司。</td></tr>}</tbody></table></TableWrap>
    <div className="watch-pagination"><button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil(companyRows.length / 25))} · 每页25家</span><button disabled={(page + 1) * 25 >= companyRows.length} onClick={() => setPage(page + 1)}>下一页</button></div>

    </>}
  </PageShell>;
}

export function AhView({initialSection='active'}:{initialSection?:string}={}) {
  const [view, setView] = useState("details");
  const [detailPage, setDetailPage] = useState(0);
  const [section, setSection] = useState(initialSection==='listed'?'listed':'active');
  const [mode, setMode] = useState<"active" | "listed">(initialSection==='listed'?'listed':'active');
  const [filter, setFilter] = useState("");
  const [exchange, setExchange] = useState("全部");
  const [marketCapBand, setMarketCapBand] = useState("全部");
  const [stage, setStage] = useState("全部");
  const [listingYear, setListingYear] = useState("全部");
  const [sponsor, setSponsor] = useState("全部");
  const rankBand = marketCapBand;
  const setRankBand = setMarketCapBand;
  const marketCapBands = useMemo(() => {
    const available = new Set([...dashboard.research_a_to_h_active, ...dashboard.a_to_h_listed].map((item) => item.a_market_cap_band));
    return ahMarketCapOrder.filter((item) => available.has(item));
  }, []);
  const activeSponsorOptions = useMemo(() => [...new Set(dashboard.research_a_to_h_active.flatMap((item) => item.sponsors))].sort((a, b) => a.localeCompare(b, "zh-CN")), []);
  const listedSponsorOptions = useMemo(() => [...new Set(dashboard.a_to_h_listed.flatMap((item) => item.sponsors))].sort((a, b) => a.localeCompare(b, "zh-CN")), []);
  const listingYears = useMemo(() => [...new Set(dashboard.a_to_h_listed.map((item) => item.hk_listing_date?.slice(0, 4)).filter(Boolean))].sort().reverse(), []);
  const active = useMemo(() => dashboard.research_a_to_h_active.filter((item) =>
    (exchange === "全部" || item.a_exchange === exchange)
    && (marketCapBand === "全部" || item.a_market_cap_band === marketCapBand)
    && (stage === "全部" || (stage === "PHIP" ? item.status.includes("PHIP") : !item.status.includes("PHIP")))
    && (sponsor === "全部" || (item.sponsors as readonly string[]).includes(sponsor))
    && `${item.company_name}${item.a_code}${item.a_short_name}${item.sponsors.join("")}`.toLowerCase().includes(filter.toLowerCase())
  ), [filter, exchange, marketCapBand, stage, sponsor]);
  const listedBase = useMemo(() => dashboard.a_to_h_listed.filter((item) =>
    (exchange === "全部" || item.a_exchange === exchange)
    && (listingYear === "全部" || item.hk_listing_date?.startsWith(listingYear))
    && (sponsor === "全部" || (item.sponsors as readonly string[]).includes(sponsor))
    && `${item.company_name}${item.a_code}${item.hk_code}${item.a_short_name}${item.sponsors.join("")}`.toLowerCase().includes(filter.toLowerCase())
  ), [filter, exchange, listingYear, sponsor]);
  const listed = useMemo(() => listedBase.filter((item) => marketCapBand === "全部" || item.a_market_cap_band === marketCapBand), [listedBase, marketCapBand]);
  const rankEligibleActive = useMemo(() => dashboard.research_a_to_h_active.filter((item) =>
    (exchange === "全部" || item.a_exchange === exchange)
    && (stage === "全部" || (stage === "PHIP" ? item.status.includes("PHIP") : !item.status.includes("PHIP")))
    && (rankBand === "全部" || item.a_market_cap_band === rankBand)
  ), [exchange, stage, rankBand]);
  const rankEligibleListed = useMemo(() => listedBase.filter((item) =>
    (exchange === "全部" || item.a_exchange === exchange)
    && (listingYear === "全部" || item.hk_listing_date?.startsWith(listingYear))
    && item.is_fundraising_ipo
    && (rankBand === "全部" || item.a_market_cap_band === rankBand)
  ), [listedBase, exchange, listingYear, rankBand]);
  const activeSummary = useMemo(() => summarizeActiveAh(active), [active]);
  const activeIssueRanking = useMemo(() => rankActiveAhByPredictedIssue(rankEligibleActive), [rankEligibleActive]);
  const listedSummary = useMemo(() => summarizeListedAh(listed, Object.fromEntries(dashboard.year_summary.map((item) => [String(item.year), item.ipo_count]))), [listed]);
  const listedSponsorRanking = useMemo(() => rankListedAhSponsors(rankEligibleListed), [rankEligibleListed]);
  const rankBandProceeds = rankEligibleListed.reduce((sum, item) => sum + (item.hk_proceeds_hkd ?? 0), 0);
  const detailKey=JSON.stringify([mode,filter,exchange,marketCapBand,stage,listingYear,sponsor]);
  const [previousDetail,setPreviousDetail]=useState(detailKey);
  if(previousDetail!==detailKey){setPreviousDetail(detailKey);setDetailPage(0);}
  const detailCount = mode === "active" ? active.length : listed.length;
  const assumptions = dashboard.model_assumptions;
  return <PageShell eyebrow="A/H DUAL-SOURCE VERIFICATION" title="A→H专题" text="港交所记录与沪深官方证券名录交叉核验；繁简体、简称与公司全名统一后再匹配。">
    {dashboard.active_state_conflicts.length>0&&<p className="table-note">研究名单已按公司终止等明确证据调整，与原始公开索引存在 {dashboard.active_state_conflicts.length} 家状态冲突；详见“递表与在审”的口径对照。历史原记录仍保留于完整快照。</p>}
    <PipelineOverview onlyAh onSelect={setSection} />
    <PipelineNavigation onlyAh value={section} onChange={value => { setSection(value); if(value === "active" || value === "listed") { setMode(value); setSponsor("全部"); } }} listedCount={dashboard.a_to_h_listed.length} />
    {section !== 'listed' ? <PipelineExplorer key={section} onlyAh category={section} /> : <>
    <div className="content-view-switch" aria-label="A→H展示方式"><button aria-pressed={view === "details"} onClick={() => setView("details")}>公司明细</button><button aria-pressed={view === "analysis"} onClick={() => setView("analysis")}>{mode === "active" ? "市值统计与发行规模排名" : "年度统计与保荐人排名"}</button></div>
    <div className="switch-row"><h2>{mode === "active" ? "核验后公开申请" : "历史已上市"}</h2><label className="inline-search">检索<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="公司、代码、保荐人" /></label>{mode === "listed" && <SourceLink className="outline-button" href={exportUrl("ah-listed",listed.map(r=>dashboard.a_to_h_listed.indexOf(r)))} download>下载当前历史公司筛选 CSV ↓</SourceLink>}<DownloadLinks primary="/data/a_to_h.csv" /></div>
    <div className="toolbar ah-toolbar">
      <label>A股市场<select value={exchange} onChange={(event) => setExchange(event.target.value)}><option>全部</option><option value="SSE">上交所</option><option value="SZSE">深交所</option></select></label>
      <label>市值分档<select value={marketCapBand} onChange={(event) => { setMarketCapBand(event.target.value); }}><option>全部</option>{marketCapBands.map((item) => <option key={item}>{item}</option>)}</select></label>
      {mode === "active" ? <><label>申请阶段<select value={stage} onChange={(event) => setStage(event.target.value)}><option>全部</option><option>AP</option><option>PHIP</option></select></label><label>保荐机构<select value={sponsor} onChange={(event) => setSponsor(event.target.value)}><option>全部</option>{activeSponsorOptions.map((item) => <option key={item}>{item}</option>)}</select></label></> : <><label>港股上市年<select value={listingYear} onChange={(event) => setListingYear(event.target.value)}><option>全部</option>{listingYears.map((item) => <option key={item}>{item}</option>)}</select></label><label>保荐机构<select value={sponsor} onChange={(event) => setSponsor(event.target.value)}><option>全部</option>{listedSponsorOptions.map((item) => <option key={item}>{item}</option>)}</select></label></>}
      <button className="filter-reset" onClick={() => { setFilter(""); setExchange("全部"); setMarketCapBand("全部"); setStage("全部"); setListingYear("全部"); setSponsor("全部"); setRankBand("1,000亿元以上"); }}>重置筛选</button>
    </div>
    {view === "analysis" && <><p className="table-note">当前筛选 {mode === "active" ? active.length : listed.length} 家。{mode === "active" ? `预测仅为情景模型：H/A折价 ${assumptions.ha_discount_pct}% · 发行比例 ${assumptions.issue_ratio_pct}% · 绿鞋 ${assumptions.greenshoe_pct}%。` : "历史已上市为独立样本，不计入待上市储备。"}</p>
    {mode === "active" ? <><section className="summary-block">
      <div className="summary-heading"><div><p className="eyebrow">ACTIVE A→H BREAKDOWN</p><h2>当前申请详细汇总</h2></div><span>当前筛选 {active.length} 家 · 按A股市值分档</span></div>
      <div className="summary-table-wrap"><table className="summary-table"><thead><tr><th>市值分档</th><th>公司数 / 占比</th><th>AP / PHIP</th><th>行情覆盖</th><th>A股市值合计</th><th>推算H股估值</th><th>基础发行规模</th><th>绿鞋后规模</th></tr></thead><tbody>{activeSummary.map((item) => <tr key={item.band}><td><b>{item.band}</b></td><td>{item.count} 家<small>{active.length ? n(item.count / active.length * 100, 1) : "0.0"}%</small></td><td>{item.apCount} / {item.phipCount}</td><td>{item.marketDataCount}/{item.count}</td><td>{rmbBn(item.aMarketCapRmbBn)}</td><td>{rmbBn(item.hValuationRmbBn)}</td><td className="model-value">{rmbBn(item.baseIssueRmbBn)}</td><td className="model-value">{rmbBn(item.maxIssueRmbBn)}</td></tr>)}</tbody></table></div>
    </section>
      <section className="summary-block active-ah-issue-ranking">
        <div className="summary-heading"><div><p className="eyebrow">ACTIVE A→H PREDICTED ISSUE SIZE BY A-SHARE MARKET CAP</p><h2>当前A→H分市值档预测发行规模排名</h2></div><span>{rankBand} · {rankEligibleActive.length} 个项目 · 按绿鞋后预测规模降序</span></div>
        <div className="rank-band-tabs" aria-label="选择当前A→H市值分档">{["全部", ...marketCapBands.filter((item) => item !== "待官方行情")].map((item) => <button key={item} className={rankBand === item ? "active" : ""} onClick={() => setRankBand(item)}>{item}<small>{dashboard.research_a_to_h_active.filter((row) => (item === "全部" || row.a_market_cap_band === item)).length} 项</small></button>)}</div>
        <div className="rank-band-title"><b>{rankBand} 预测发行规模排名</b><span>绿鞋后规模＝A股市值 ×（1－H/A折价）× 发行比例 ×（1＋绿鞋）</span></div>
        <div className="summary-table-wrap"><table className="summary-table"><thead><tr><th>排名</th><th>公司 / A股代码</th><th>A股市场</th><th>A股市值</th><th>推算H股估值</th><th>基础发行规模</th><th>绿鞋后预测规模</th><th>阶段</th><th>保荐人</th></tr></thead><tbody>{activeIssueRanking.map((item, index) => <tr key={`${item.application_id}-${item.a_code}`}><td className="rank-number">{String(index + 1).padStart(2, "0")}</td><td className="company-cell"><b>{item.company_name}</b><small>{item.a_code} · {item.a_short_name}</small></td><td>{item.a_exchange}</td><td>{rmbBn(item.a_market_cap_rmb_bn)}</td><td>{rmbBn(item.estimated_h_valuation_rmb_bn)}</td><td>{rmbBn(item.estimated_base_issue_rmb_bn)}</td><td className="model-value"><b>{rmbBn(item.estimated_max_issue_rmb_bn)}</b></td><td><span className="pill gold-pill">{item.status.includes("PHIP") ? "PHIP" : "AP"}</span></td><td className="wide-cell">{item.sponsors.join(" / ") || "待解析"}</td></tr>)}{activeIssueRanking.length === 0 && <tr><td colSpan={9}>该市值档在当前A股市场／申请阶段条件下暂无可排名项目。</td></tr>}</tbody></table></div>
        <p className="table-note">该榜单排名公司而非保荐机构；规模为透明情景测算，并非发行人、保荐人或交易所预测。排名随“A股市场”和“申请阶段”联动，不受公司检索、明细市值档或保荐机构筛选影响。</p>
      </section>
    </> : <>
      <section className="summary-block">
        <div className="summary-heading"><div><p className="eyebrow">LISTED A→H BREAKDOWN</p><h2>历史上市详细汇总</h2></div><span>当前筛选 {listed.length} 家 · 按港股上市年份</span></div>
        <div className="summary-table-wrap"><table className="summary-table"><thead><tr><th>港股上市年</th><th>A→H上市事件</th><th>其中募资型IPO / 占当年IPO</th><th>上交所 / 深交所</th><th>港股募资额</th><th>平均IPO募资</th><th>A股市值合计</th><th>行情覆盖</th></tr></thead><tbody>{listedSummary.map((item) => <tr key={item.year}><td><b>{item.year}</b></td><td>{item.count} 家</td><td>{item.fundraisingIpoCount} 家<small>{item.shareOfAnnualIpoPct == null ? "—" : `${n(item.shareOfAnnualIpoPct, 1)}%`}</small></td><td>{item.sseCount} / {item.szseCount}</td><td>HK${n(item.proceedsHkdBn, 2)}bn</td><td>HK${n(item.averageProceedsHkdBn, 2)}bn</td><td>{rmbBn(item.aMarketCapRmbBn)}</td><td>{item.marketDataCount}/{item.count}</td></tr>)}</tbody></table></div>
      </section>
      <section className="summary-block ah-sponsor-ranking">
        <div className="summary-heading"><div><p className="eyebrow">LISTED A→H SPONSOR LEAGUE TABLE BY A-SHARE MARKET CAP</p><h2>已上市A→H保荐人分市值档发行规模排名</h2></div><span>当前A股市值分档 · {rankEligibleListed.length} 个项目 · 实际港股募资 HK${n(rankBandProceeds / 1_000_000_000, 2)}bn</span></div>
        <div className="rank-band-tabs" aria-label="选择A股市值分档">{["全部", ...marketCapBands.filter((item) => item !== "待官方行情")].map((item) => <button key={item} className={rankBand === item ? "active" : ""} onClick={() => setRankBand(item)}>{item}<small>{listedBase.filter((row) => row.is_fundraising_ipo && (item === "全部" || row.a_market_cap_band === item)).length} 项</small></button>)}</div>
        <div className="rank-band-title"><b>{rankBand} A→H保荐人排名</b><span>按 Full Credit 港股实际发行规模降序</span></div>
        <div className="summary-table-wrap"><table className="summary-table"><thead><tr><th>排名</th><th>保荐机构</th><th>A→H项目</th><th>Full Credit发行规模</th><th>Equal Split归属规模</th><th>平均单宗规模</th><th>最大A→H项目</th></tr></thead><tbody>{listedSponsorRanking.slice(0, 10).map((item, index) => <tr key={item.sponsor}><td className="rank-number">{String(index + 1).padStart(2, "0")}</td><td className="wide-cell"><b>{item.sponsor}</b></td><td>{item.dealCount} 项</td><td><b>HK${n(item.fullCreditProceedsHkdBn, 2)}bn</b></td><td>HK${n(item.splitCreditProceedsHkdBn, 2)}bn</td><td>HK${n(item.averageDealProceedsHkdBn, 2)}bn</td><td className="company-cell">{item.largestDeal ? <><b>{compactName(item.largestDeal.companyName)}</b><small>{item.largestDeal.hkCode} · HK${n(item.largestDeal.proceedsHkdBn, 2)}bn</small></> : "—"}</td></tr>)}{listedSponsorRanking.length === 0 && <tr><td colSpan={7}>该市值档在当前A股市场／港股上市年条件下暂无可排名项目。</td></tr>}</tbody></table></div>
        <p className="table-note">每个市值档独立排名，联动公司、市场、年份及保荐机构筛选，只纳入募资型A→H IPO；介绍上市等零募资事件保留在历史核验明细，但不进入保荐人发行规模排名。A股市值采用网站快照期最新官方行情。Full Credit 为每家联席保荐人计入项目全部募资额，Equal Split 为联席保荐人平均分配。</p>
      </section>
    </>}
    </>}
    {view === "details" && <><p className="table-note">当前筛选 {mode === "active" ? active.length : listed.length} 家 · 按公司查看明细，统计和排名请切换上方视图。</p>
    {mode === "active" ? <TableWrap><table><thead><tr><th>公司 / A股代码</th><th>A股板块 / 行业</th><th>A股市值</th><th>市值分档</th><th>首次 / 最新递表</th><th>阶段</th><th>保荐人</th><th>推算H股估值</th><th>基础发行规模</th><th>绿鞋后规模</th><th>双源证据</th></tr></thead><tbody>{active.slice(detailPage * 25, (detailPage + 1) * 25).map((item) => <tr key={`${item.application_id}-${item.a_code}`}><td className="company-cell"><b>{item.company_name}</b><small>{item.a_code} · {item.a_short_name}</small></td><td>{item.a_exchange}<small>{item.a_industry || "—"}</small></td><td>{rmbBn(item.a_market_cap_rmb_bn)}<small>截至 {item.market_data_date || "—"}</small></td><td><span className="pill">{item.a_market_cap_band}</span></td><td>{item.hk_first_document_date}<small>{item.hk_latest_document_date}</small></td><td><span className="pill gold-pill">{item.status}</span></td><td className="wide-cell">{item.sponsors.join(" / ") || "待解析"}</td><td>{rmbBn(item.estimated_h_valuation_rmb_bn)}</td><td className="model-value">{rmbBn(item.estimated_base_issue_rmb_bn)}</td><td className="model-value">{rmbBn(item.estimated_max_issue_rmb_bn)}</td><td><SourceLink href={item.a_official_url} target="_blank" rel="noreferrer">A股 <ExternalIcon /></SourceLink>{item.hk_official_url && <SourceLink href={item.hk_official_url} target="_blank" rel="noreferrer">HKEX <ExternalIcon /></SourceLink>}<small>{item.source_grade} · {item.name_cross_check}</small></td></tr>)}</tbody></table></TableWrap> : <TableWrap><table><thead><tr><th>港股上市日</th><th>上市方式</th><th>公司</th><th>港股代码</th><th>A股代码 / 市场 / 上市日</th><th>A股行业</th><th>港股发售价</th><th>港股募资额</th><th>保荐人</th><th>A股市值</th><th>市值分档</th><th>交叉核验</th><th>官方来源</th></tr></thead><tbody>{listed.slice(detailPage * 25, (detailPage + 1) * 25).map((item) => <tr key={`${item.hk_code}-${item.a_code}`}><td>{item.hk_listing_date}</td><td><span className={`pill ${item.is_fundraising_ipo ? "gold-pill" : ""}`}>{item.hk_listing_method}</span></td><td className="company-cell"><b>{compactName(item.company_name)}</b><small>{item.a_short_name}</small></td><td className="mono">{item.hk_code}</td><td><SourceLink href={item.a_official_url} target="_blank" rel="noreferrer">{item.a_code} · {item.a_exchange} <ExternalIcon /></SourceLink><small>{item.a_listing_date}</small></td><td>{item.a_industry || "—"}</td><td>{item.hk_offer_price == null ? "—" : `HK$${n(item.hk_offer_price, 2)}`}</td><td>{hkdBn(item.hk_proceeds_hkd)}</td><td className="wide-cell">{item.is_fundraising_ipo ? item.sponsors.join(" / ") || "—" : "不计入IPO排名"}</td><td>{rmbBn(item.a_market_cap_rmb_bn)}<small>{item.market_data_date || "—"}</small></td><td>{item.a_market_cap_band}</td><td><span className="pill">{item.name_cross_check}</span></td><td><SourceLink href={item.hk_official_url} target="_blank" rel="noreferrer">HKEX <ExternalIcon /></SourceLink></td></tr>)}</tbody></table></TableWrap>}
    {!detailCount && <p className="table-note">暂无符合筛选条件的公司。</p>}
    <div className="watch-pagination"><button disabled={detailPage === 0} onClick={() => setDetailPage(detailPage - 1)}>上一页</button><span>{detailPage + 1} / {Math.max(1, Math.ceil(detailCount / 25))} · 每页25家</span><button disabled={(detailPage + 1) * 25 >= detailCount} onClick={() => setDetailPage(detailPage + 1)}>下一页</button></div>
    <p className="table-note">A股市值来自上交所最新总市值，或深交所官方收盘价 × 官方总股本；预测字段为透明情景模型，不代表发行人或保荐人意见。</p>
    </>}
    </>}
  </PageShell>;
}

function SponsorsView() {
  const [mode, setMode] = useState<"listed" | "applications">("listed");
  const [filter, setFilter] = useState("");
  const listedRanked = useMemo(() => rankSponsorsByProceeds(dashboard.sponsor_listed_summary), []);
  const listedRankBySponsor = useMemo(() => new Map(listedRanked.map((item, index) => [item.sponsor, index + 1])), [listedRanked]);
  const listed = listedRanked.filter((item) => item.sponsor.toLowerCase().includes(filter.toLowerCase()));
  const applications = dashboard.sponsor_application_summary.filter((item) => item.sponsor.toLowerCase().includes(filter.toLowerCase()));
  const top10 = listed.slice(0, 10);
  return <PageShell eyebrow="SPONSOR PROJECT DATABASE" title="保荐机构与项目" text={`已经上市项目按${dashboard.coverage.end_year}年 Full Credit 募资额排名；点击每家机构可展开具体项目、日期、阶段和官方链接。`}>
    <div className="switch-row"><div className="segmented"><button className={mode === "listed" ? "active" : ""} onClick={() => setMode("listed")}>已经上市</button><button className={mode === "applications" ? "active" : ""} onClick={() => setMode("applications")}>递表与在审</button></div>{mode==="listed"&&<label className="inline-search">检索机构<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="保荐人名称" /></label>}</div>
    {mode === "listed" && <section className="summary-block sponsor-ranking">
      <div className="summary-heading"><div><p className="eyebrow">SPONSOR LEAGUE TABLE</p><h2>{dashboard.coverage.end_year}年保荐机构募资额 Top 10（当前检索）</h2></div><span>按 Full Credit 募资额降序 · 截至 {sourceDate}</span></div>
      <div className="summary-table-wrap"><table className="summary-table"><thead><tr><th>排名</th><th>保荐机构</th><th>年内IPO</th><th>年内募资额</th><th>六年项目数</th><th>六年募资额</th><th>年内最大项目</th></tr></thead><tbody>{top10.map((item, index) => {
        const largest = item.projects.filter((project) => project.year === dashboard.coverage.end_year).sort((left, right) => right.proceeds_hkd_bn - left.proceeds_hkd_bn)[0];
        return <tr key={item.sponsor}><td className="rank-number">{String(index + 1).padStart(2, "0")}</td><td className="wide-cell"><b>{item.sponsor}</b></td><td>{item.current_year_ipo_count} 项</td><td><b>HK${n(item.current_year_attributed_proceeds_hkd_bn, 2)}bn</b></td><td>{item.all_period_ipo_count} 项</td><td>HK${n(item.all_period_attributed_proceeds_hkd_bn, 2)}bn</td><td className="company-cell">{largest ? <><b>{compactName(largest.company_name)}</b><small>HK${n(largest.proceeds_hkd_bn, 2)}bn</small></> : "—"}</td></tr>;
      })}</tbody></table></div>
    </section>}
    {mode === "applications" ? <SponsorProjects initialQuery={filter} key={filter} /> : <div className="sponsor-list">{mode === "listed" ? listed.map((item) => <details key={item.sponsor}><summary><span>{String(listedRankBySponsor.get(item.sponsor) ?? 0).padStart(2, "0")}</span><b>{item.sponsor}</b><em>年内 {item.current_year_ipo_count} 项</em><em>六年 {item.all_period_ipo_count} 项</em><strong>HK${n(item.current_year_attributed_proceeds_hkd_bn, 2)}bn</strong><i>⌄</i></summary><div className="detail-table"><table><thead><tr><th>上市日</th><th>代码 / 公司</th><th>市场</th><th>募资额</th><th>来源</th></tr></thead><tbody>{item.projects.map((project) => <tr key={`${project.hk_code}-${project.listing_date}`}><td>{project.listing_date}</td><td><b>{project.company_name}</b><small>{project.hk_code}</small></td><td>{project.market}</td><td>HK${n(project.proceeds_hkd_bn, 2)}bn</td><td><SourceLink href={dashboard.listings.find(r=>r.hk_code===project.hk_code&&r.listing_date===project.listing_date)?.original_document_url||project.source_url} target="_blank" rel="noreferrer">公司原文件 <ExternalIcon /></SourceLink></td></tr>)}</tbody></table></div></details>) : applications.map((item, index) => <details key={item.sponsor}><summary><span>{String(index + 1).padStart(2, "0")}</span><b>{item.sponsor}</b><em>公开申请 {item.active_project_count} 项</em><em>PHIP {item.phip_count} 项</em><strong>{item.active_project_count} 项</strong><i>⌄</i></summary><div className="detail-table"><table><thead><tr><th>最新文件日</th><th>申请人</th><th>市场</th><th>阶段</th><th>轮次</th><th>来源</th></tr></thead><tbody>{item.projects.map((project) => <tr key={project.application_id}><td>{project.latest_document_date}</td><td><b>{project.company_name}</b><small>ID {project.application_id}</small></td><td>{project.market}</td><td><span className="pill">{project.stage}</span></td><td>{project.application_rounds}</td><td>{project.source_url ? <SourceLink href={project.source_url} target="_blank" rel="noreferrer">HKEXnews <ExternalIcon /></SourceLink> : "—"}</td></tr>)}</tbody></table></div></details>)}</div>}
    {mode==="listed"&&!listed.length&&<p role="status">暂无匹配的保荐机构。</p>}
    <p className="table-note">已上市排名按年内募资额降序；联席项目采用 Full Credit，即每家联席保荐机构均计入该项目全部募资额。申请保荐人来自招股书参与方章节，研究名单当前覆盖 {dashboard.research_active_applications.filter(r=>r.sponsors.length>0).length}/{dashboard.research_active_applications.length} 宗；明确终止等状态冲突项目不计入目录，未核实保荐人的项目不猜测补齐。</p>
  </PageShell>;
}

function MethodologyView() {
  const quality = dashboard.quality;
  const correction = (dashboard as {research_correction?: {corrected_at: string}}).research_correction;
  const processing = dashboard.official_processing_statistics[0];
  return <PageShell eyebrow="METHODOLOGY, SOURCES & QUALITY" title="口径、来源与自动更新" text="把官方事实、计算指标和情景模型分层展示；缺失值不猜测。">
    <div className="method-grid"><article><span>01</span><h2>两种在审口径分离</h2><p>港交所月报“审核处理中”按监管申请宗数统计；HKEXnews当前AP/PHIP按公开申请ID去重。两者分开展示，不再以同一“在审家数”混称。</p></article><article><span>02</span><h2>港交所全量采集</h2><p>主板及GEM年度新上市报告、当前AP/PHIP、失效/上市/退回状态及逐年申请索引均保存原始文件和SHA-256。</p></article><article><span>03</span><h2>上市事件与IPO分离</h2><p>港交所“新上市报告”中的介绍上市、GEM转板、De-SPAC继承公司及其他零募资事件保留审计记录，但不计入IPO家数、募资额、A→H IPO占比或保荐人排名。</p></article><article><span>04</span><h2>保荐人逐项目解析</h2><p>从每份最新申请版本的参与方章节提取保荐人，并保留章节PDF链接；后续周更只处理新增或变更文件。</p></article><article><span>05</span><h2>A→H双源核验</h2><p>繁简体与公司后缀标准化后，以HKEX申请记录和SSE/SZSE官方股票名录交叉匹配；历史上市同时核对A股上市日早于H股上市日；H→A及名称未通过核验的记录单列排除。介绍上市保留在历史事件中，但不计入IPO排名。</p></article><article><span>06</span><h2>行情与模型分离</h2><p>A股市值来自交易所行情；H股估值、基础发行规模及绿鞋敏感性均标为情景测算，参数公开并写入快照。</p></article><article><span>07</span><h2>不可变周度快照</h2><p>每周任务生成日期快照、JSON与UTF-8 BOM CSV，执行数量、主键、金额、分类及链接格式校验，链接内容另行核验，失败不会覆盖上一成功版本。</p></article></div>
    <ScopeComparison />
    <ListingContinuityNote />
    <div className="quality-grid"><div><span>募资型IPO记录</span><b>{n(dashboard.coverage.listing_records)}</b></div><div><span>非IPO事件排除</span><b>{n(dashboard.coverage.non_ipo_listing_records_excluded)}</b></div><div><span>公司级原文件直链</span><b>{n(quality.official_listing_rows_with_original_prospectus)} / {n(dashboard.coverage.listing_records)}</b></div><div><span>原文件直链覆盖率</span><b>{n(quality.official_listing_original_prospectus_coverage_pct, 1)}%</b></div><div><span>港交所月报审核中</span><b>{n(processing.under_processing_total)}</b></div><div><span>HKEXnews公开记录 / 公司</span><b>{n(dashboard.coverage.active_application_records)} / {n(dashboard.active_application_scope.unique_company_names)}</b></div><div><span>申请历史</span><b>{n(dashboard.coverage.application_history_records)}</b></div><div><span>A股官方名录</span><b>{n(dashboard.coverage.a_share_official_records)}</b></div><div><span>A→H当前申请</span><b>{n(dashboard.research_a_to_h_active.length)}</b></div></div>
    {correction&&<p className="table-note">研究数据纠错：{correction.corrected_at.slice(0,10)}。本次依据已保存官方证据重算，官方底表仍为 {dashboard.snapshot_date}，不代表重新采集至纠错日。</p>}
    <LinkAuditSummary />
    <div className="source-catalog"><h2>官方生产数据源</h2>{dashboard.official_sources.map((source) => <SourceLink key={source.label} href={source.url} target="_blank" rel="noreferrer"><span>{source.label}</span><b>官方来源</b><ExternalIcon /></SourceLink>)}</div>
    <div className="limitations"><h2>已知限制</h2>{quality.limitations.map((item) => <p key={item}><i>!</i>{item}</p>)}</div>
    <section className="summary-block"><div className="summary-heading"><div><h2>A→H排除与纠错记录</h2><p>不采纳的代码配对单独留痕，不删除原始证据。</p></div><SourceLink href="/data/a_to_h_exclusions.csv" download>下载排除明细 ↓</SourceLink></div><TableWrap><table><thead><tr><th>港股公司</th><th>未采纳的A股代码</th><th>A股 / H股上市日</th><th>排除原因</th><th>双源证据</th></tr></thead><tbody>{dashboard.a_to_h_exclusions.map((row, index) => <tr key={index}><td>{row.company_name}</td><td>{row.a_code}</td><td>{row.a_listing_date || "—"} / {row.hk_listing_date || "—"}</td><td>{row.reason}</td><td><SourceLink href={row.a_official_url} target="_blank" rel="noreferrer">A股 ↗</SourceLink><SourceLink href={row.hk_official_url || undefined} target="_blank" rel="noreferrer">HKEX ↗</SourceLink></td></tr>)}</tbody></table></TableWrap></section>
    <DownloadLinks primary="/data/full_snapshot.json" />
  </PageShell>;
}

function ListingContinuityNote() {
  const f=dashboard.quality.source_freshness,c=f.listing_continuity;
  return <details className="scope-reference"><summary>上市数据衔接依据：年度报告 {f.hkex_new_listing_report_as_of} · 近期上市名录 {f.hkex_newly_listed_securities_as_of}</summary><p>{c.note}。补录代码：{f.verified_post_nlr_listing_codes.join('、')||'无'}。</p>{c.parent_sha256&&<p>历史证据来自 {c.parent_snapshot_date} 成功快照，已验证覆盖至 {c.parent_coverage_through}；SHA-256：<code style={{overflowWrap:'anywhere'}}>{c.parent_sha256}</code>。</p>}<p>滚动名录与历史覆盖期必须重叠；未核实的新上市股或来源断档均阻止发布。原始年度报告日期不会改成采集日期。</p></details>;
}

function Metric({ label, value, note, onClick }: { label: string; value: string; note: string; onClick: () => void }) { return <button className="kpi" onClick={onClick}><span>{label}</span><strong>{value}</strong><small>{note}</small><i>↗</i></button>; }
function SectionHead({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) { return <div className="section-head"><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{text}</p></div>; }
function PageShell({ eyebrow, title, text, children }: { eyebrow: string; title: string; text: string; children: React.ReactNode }) { return <><section className="page-hero"><div><p className="eyebrow gold-text">{eyebrow}</p><h1>{title}</h1><p>{text}</p></div><div className="page-meta"><span><i className="status" /> 官方快照已生成</span><small>数据截至 {sourceDate}</small></div></section><section className="section light page-content">{children}</section></>; }
function DataToolbar({ filter, setFilter, children }: { filter: string; setFilter: (value: string) => void; children: React.ReactNode }) { return <div className="toolbar"><label>检索<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="公司、代码、保荐人或机构" /></label>{children}</div>; }
function DownloadLinks({ primary }: { primary: string }) { return <div className="download-actions"><SourceLink className="outline-button" href={primary} download>下载全量明细 ↓</SourceLink><SourceLink className="outline-button" href="/data/full_snapshot.json" download>完整快照 ↓</SourceLink></div>; }
function TableWrap({ children }: { children: React.ReactNode }) { return <div className="table-wrap">{children}</div>; }
function officialApplicationLink(item: Application) {
  const ranked = item.documents.flatMap((document) => {
    const url = document.full_document_url || document.multi_file_url;
    if (!url) return [];
    const label = `${document.document_type || ""} ${document.full_document_name || ""}`.toUpperCase();
    const priority = /PHIP|聆訊後|聆讯后/.test(label) ? 3 : /申請版本|申请版本|APPLICATION PROOF/.test(label) ? 2 : 1;
    return [{ priority, date: document.date || "", url }];
  });
  ranked.sort((left, right) => right.priority - left.priority || right.date.localeCompare(left.date));
  return ranked[0]?.url || item.warning_url;
}
