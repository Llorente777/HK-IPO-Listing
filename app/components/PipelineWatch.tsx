"use client";
import { SourceLink } from './SourceLink';
import { exportUrl } from '@/lib/export-url';
import { applicationScopeNote, verifiedApplicationLabel } from '@/lib/application-scope';
import { pipelineCompanies } from '@/lib/pipeline-analytics';

import { useState } from "react";
import watchData from "@/data/processed/pipeline_watch.json";

type TerminationReview = { checked_at: string; conclusion: string; scope: string; query: string; sources: { title: string; url: string }[]; note: string };
type Evidence = { date: string; kind: string; level: string; source_tier?: string; publisher: string; title: string; url: string; summary: string };
export type WatchRow = { id: string; company_name: string; aliases: string[]; bucket: string; status: string; status_label: string; is_a_to_h: boolean; a_code: string | null; a_exchange: string | null; a_short_name: string | null; a_official_url: string | null; a_industry: string | null; first_application_date: string | null; last_application_date: string | null; application_id: string | null; attempt_count: number; official_status: string | null; official_url: string | null; estimated_lapse_date: string | null; evidence_date: string | null; evidence_age_days: number | null; needs_review: boolean; events: Evidence[]; termination_review?: TerminationReview | null; note: string };
type ClassifiedWatchRow = WatchRow & { last_prospectus_update_date: string | null; confidential_tier: string | null; confidential_tier_label: string | null; classification_source: Evidence | null };
export const watchRows: ClassifiedWatchRow[] = watchData.rows;
const sponsorEvidence = new Map(pipelineCompanies.map(r => [r.id, r]));
export function reserveSponsors(id: string) {
  const row = sponsorEvidence.get(id);
  return row?.category === 'reserve' && row.sponsor_source_url ? row.sponsors : [];
}

export function PipelineNavigation({onlyAh = false, value, onChange, listedCount}: {onlyAh?: boolean; value: string; onChange: (value: string) => void; listedCount?: number}) {
  const base = watchRows.filter(r => !onlyAh || r.is_a_to_h);
  const groups = [
    {key: "active", label: verifiedApplicationLabel, count: base.filter(r => r.status === "public_active").length, note: applicationScopeNote(onlyAh)},
    {key: "reserve", label: "公开递表储备", count: base.filter(r => r.bucket === "public" && r.status !== "public_active").length, note: "含失效 · 招股书近一年有更新"},
    {key: "confidential", label: "密交储备与线索", count: base.filter(r => r.bucket === "confidential").length, note: "分两档来源 · 并非全部已确认密交"},
  ];
  return <div role="navigation" className="pipeline-navigation" aria-label={onlyAh ? "A→H项目分类" : "上市项目分类"}>
    {listedCount != null && <div className="portfolio-switch"><button aria-pressed={value !== "listed"} onClick={() => onChange("active")}>待上市项目</button><button aria-pressed={value === "listed"} onClick={() => onChange("listed")}>历史已上市 <b>{listedCount}</b></button></div>}
    {value !== "listed" && <div className="pipeline-categories">{groups.map((g, i) => <button key={g.key} aria-pressed={value === g.key} className={value === g.key ? "active" : ""} onClick={() => onChange(g.key)}><span><i>0{i + 1}</i>{g.label}<strong>{g.count}<em> 家</em></strong></span><small>{g.note}</small></button>)}</div>}
    <div className="pipeline-dateline"><span>{value === "listed" ? "历史样本独立展示，不计入待上市储备" : "三类互不重复 · 均按公司计数"}</span><span>官方底表 {watchData.official_snapshot_date} · 线索复核 {watchData.evidence_reviewed_at}</span></div>
  </div>;
}

export function PipelineWatch({ onlyAh = false, initialFilter = "", category = "public" }: { onlyAh?: boolean; initialFilter?: string; category?: "public" | "confidential" }) {
  const [query, setQuery] = useState(initialFilter);
  const [phase, setPhase] = useState("all");
  const [evidence, setEvidence] = useState("all");
  const [sponsor, setSponsor] = useState("all");
  const [page, setPage] = useState(0);
  const [tier, setTier] = useState(() => watchRows.find(r => initialFilter && `${r.company_name} ${r.aliases.join(" ")}`.toLowerCase().includes(initialFilter.toLowerCase()))?.confidential_tier || "tier1");
  const base = watchRows.filter(r => r.status !== "public_active" && (!onlyAh || r.is_a_to_h));
  const publicRows = base.filter(r => r.bucket === 'public');
  const sponsorOptions = [...new Set(publicRows.flatMap(r => reserveSponsors(r.id)))].sort((a,b) => a.localeCompare(b,'zh-CN'));
  const covered = publicRows.filter(r => reserveSponsors(r.id).length).length;
  const filtered = base.filter(r =>
    r.bucket === category
    && (category !== "confidential" || r.confidential_tier === tier)
    && (phase === "all" || (phase === "lapsed" ? r.status.startsWith("lapsed_") : !r.status.startsWith("lapsed_")))
    && (evidence === "all" || (evidence === "none" ? !r.events.length : r.events.some(e => evidence === "media" ? e.level === "media" : e.level !== "media")))
    && (category !== 'public' || sponsor === 'all' || (sponsor === 'missing' ? !reserveSponsors(r.id).length : reserveSponsors(r.id).includes(sponsor)))
    && `${r.company_name} ${r.a_code || ""} ${r.a_short_name || ""} ${r.aliases.join(" ")} ${category === 'public' ? reserveSponsors(r.id).join(' ') : ''}`.toLowerCase().includes(query.toLowerCase())
  );
  const downloadFiltered = () => window.location.assign(exportUrl("watch",filtered.map(r=>watchData.rows.findIndex(a=>a.id===r.id))));
  const shown = filtered.slice(page * 25, (page + 1) * 25);
  return <section className={`summary-block pipeline-watch ${category === "confidential" ? "confidential-table" : "public-reserve-table"}`}>
    <div className="summary-heading"><div><p className="eyebrow">{category === "public" ? "PUBLIC FILING RESERVE" : "CONFIDENTIAL FILING WATCH"}</p><h2>{category === "public" ? "公开递表储备明细" : "保密递交储备明细"}</h2></div><span>{base.filter(r => r.bucket === category).length} 家 · 不含官方公开有效申请</span></div>
    <p className="watch-brief">{category === "public" ? "含已失效申请，按最近一年招股书更新记录保留；不代表仍在审核或已确认继续推进。" : "第一档为公司／官方确认或权威媒体据报已递交；第二档为其他媒体、拟递交及市场传闻。"}{onlyAh && " 仅含已核验的A股发行人。"}</p>
    {category === "confidential" && <div className="confidential-tiers" aria-label="密交来源分档">{(["tier1", "tier2"] as const).map(key => <button key={key} aria-pressed={tier === key} className={tier === key ? "active" : ""} onClick={() => {setTier(key);setPage(0);}}><b>{watchData.confidential_tier_labels[key]}</b><span>{base.filter(r => r.confidential_tier === key).length} 家</span></button>)}</div>}
    <div className="toolbar watch-toolbar">
      <label>{category === 'public' ? '检索公司 / A股代码 / 保荐机构' : '检索公司 / A股代码'}<input value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} placeholder={category === 'public' ? '公司、代码或历史保荐机构' : '如 Kimi、688019'} /></label>
      {category === "public" && <><label>公开申请状态<select value={phase} onChange={e => { setPhase(e.target.value); setPage(0); }}><option value="all">全部状态（含失效）</option><option value="lapsed">已失效</option><option value="other">撤回 / 退回 / 待核实</option></select></label><label>历史披露保荐人<select value={sponsor} onChange={e => {setSponsor(e.target.value);setPage(0);}}><option value="all">全部保荐机构</option><option value="missing">保荐信息待核实</option>{sponsorOptions.map(name => <option key={name} value={name}>{name}</option>)}</select></label></>}
      <label>补充证据<select value={evidence} onChange={e => { setEvidence(e.target.value); setPage(0); }}><option value="all">全部来源</option><option value="official">公司 / 官方披露</option><option value="media">媒体报道</option><option value="none">暂无补充证据</option></select></label>
      <button className="filter-reset" onClick={()=>{setQuery("");setPhase("all");setEvidence("all");setSponsor("all");setPage(0);}}>重置筛选</button><div className="download-actions"><button onClick={downloadFiltered}>下载当前筛选 CSV ↓</button></div>
    </div>
    {category === 'public' && <p className="table-note">已核实历史保荐信息 {covered} / {publicRows.length} 家；其余 {publicRows.length-covered} 家待补证据，不代表未聘保荐人。历史披露不证明当前续任。失效后原文件可能不再公开，后续更新保留已采集的历史依据。</p>}
    <p className="table-note">{category === "confidential" && `${watchData.confidential_tier_labels[tier as "tier1" | "tier2"]} · `}当前筛选 {filtered.length} 家。不并入公开有效AP/PHIP或港交所“审核处理中”家数。重新公开递表转回第一类，上市或明确终止后移出。</p>
    <div className="summary-table-wrap"><table className="summary-table"><thead><tr><th>公司 / A股身份</th><th>{category === "public" ? "公开状态 / 最新更新" : "消息性质"}</th>{category === 'public' && <th>历史披露保荐人</th>}<th>{category === "public" ? "进展证据" : "分档来源 / 报道日"}</th><th>核验提示</th><th>来源与记录详情</th></tr></thead><tbody>{shown.map(r => <tr key={r.id}>
      <td className="company-cell"><b>{r.company_name}</b>{r.a_code ? <SourceLink href={r.a_official_url!} target="_blank" rel="noreferrer">{r.a_code} · {r.a_exchange} ↗<small>{r.a_short_name}</small></SourceLink> : <small>未匹配沪深A股发行人</small>}</td>
      <td><span className={`watch-status ${["lapsed_continuing", "confidential_confirmed"].includes(r.status) ? "confirmed" : ""}`}>{r.status_label}</span>{category === "public" && <small>最近招股书更新 {r.last_prospectus_update_date || "未公开"}</small>}</td>
      {category === 'public' && <td className="reserve-sponsor-cell">{reserveSponsors(r.id).length ? <><span>{reserveSponsors(r.id).join(' / ')}</span><small>历史披露，是否续任待核</small><SourceLink href={sponsorEvidence.get(r.id)?.sponsor_source_url ?? undefined} target="_blank" rel="noreferrer">保荐人披露文件</SourceLink></> : <><span>待核实</span><small>尚未取得可核验的保荐人依据</small></>}</td>}
      <td className="watch-evidence">{r.classification_source ? <><SourceLink href={r.classification_source.url} target="_blank" rel="noreferrer">{r.classification_source.publisher} ↗</SourceLink><small>{r.classification_source.date}</small><small>{r.confidential_tier === "tier1" && r.status !== "confidential_confirmed" ? "权威媒体据报，非官方确认" : r.confidential_tier === "tier2" ? "仅作线索，不证明已经递交" : "公司／官方披露"}</small></> : r.events.length ? <><SourceLink href={r.events.at(-1)!.url} target="_blank" rel="noreferrer">{r.events.at(-1)!.publisher} ↗</SourceLink><small>{r.events.at(-1)!.date}</small></> : <span>暂无补充进展证据</span>}</td>
      <td className="watch-caution">{r.bucket === "public" ? <><span>{r.termination_review ? "本轮检索未发现明确终止" : "终止专项检索待完成"}</span><small>{r.termination_review?.checked_at} · 不等于确认仍推进</small></> : <><span>{r.status === "confidential_confirmed" ? "仅确认来源所述该次递交" : "未获得公司／监管确认"}</span><small>{r.evidence_age_days != null && r.evidence_age_days > 90 ? "原报道超过90天 · 最新进展待核" : "非全市场完整密交名单"}</small></>}</td>
      <td className="watch-evidence"><details className="row-details"><summary>查看来源与记录</summary>
        {r.classification_source && <p><b>{r.classification_source.title}</b></p>}
        {category === "public" && <p>首次递表 {r.first_application_date || "未公开"}<br />最近AP {r.last_application_date || "未公开"}<br />{r.attempt_count} 个历史申请ID · 最新ID {r.application_id}<br />官方状态：{r.official_status}</p>}
        {r.official_url && <SourceLink href={r.official_url} target="_blank" rel="noreferrer">HKEX历史申请警告页（失效后可能不再公开）↗</SourceLink>}
        {r.events.map((e, i) => <article key={i}><b>{e.date} · {e.publisher}</b><SourceLink href={e.url} target="_blank" rel="noreferrer">{e.title} ↗</SourceLink><p>{e.summary}</p></article>)}
        {r.termination_review && <div><b>终止核查 · {r.termination_review.checked_at}</b><p>{r.termination_review.scope}</p><small>检索词：{r.termination_review.query}</small>{r.termination_review.sources.map((source, i) => <SourceLink key={i} href={source.url} target="_blank" rel="noreferrer">{source.title || "检索命中文件"} ↗</SourceLink>)}</div>}
        <p>{r.note}</p>
      </details></td>
    </tr>)}{!shown.length && <tr><td colSpan={category === 'public' ? 6 : 5}>当前条件暂无符合条件的记录。没有记录不代表不存在保密申请。</td></tr>}</tbody></table></div>
    <div className="watch-pagination"><button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil(filtered.length / 25))} · 每页25家</span><button disabled={(page + 1) * 25 >= filtered.length} onClick={() => setPage(page + 1)}>下一页</button></div>
    <details className="watch-sources"><summary>纳入规则与数据下载</summary><p>{watchData.public_filing_start_date} 起追溯；最近招股书更新须不早于 {watchData.public_update_cutoff}（含当日）。仅AP／修订AP／PHIP更新续期，其他公告不续期。超过一年未更新仅移出储备，不认定终止。</p><p>密交第一档包含公司／官方确认及权威媒体据报；第二档含其他媒体、拟／可能递交与未核实传闻。均不计入公开有效申请。</p><div className="download-actions"><SourceLink href={onlyAh ? "/data/a_to_h_watch.csv" : "/data/pipeline_watch.csv"} download>全分类 CSV（含有效申请）↓</SourceLink><SourceLink href="/data/pipeline_watch.json" download>证据快照 JSON ↓</SourceLink></div></details>
    <details className="watch-sources"><summary>明确终止的项目与移除依据</summary><p>不计入以上三类。保留原始公告，后续如有正式重启需要重新核验。</p><table className="summary-table"><thead><tr><th>公司</th><th>终止披露日</th><th>依据</th></tr></thead><tbody>{watchData.resolved.filter(r => r.events.some(e => e.kind === "terminated" || e.kind === "denied")).map(r => <tr key={r.id}><td>{r.company_name}</td><td>{r.events.at(-1)?.date}</td><td><SourceLink href={r.events.at(-1)?.url} target="_blank" rel="noreferrer">{r.events.at(-1)?.title} ↗</SourceLink></td></tr>)}</tbody></table></details>
    <details className="watch-sources"><summary>信息渠道、证据标准与覆盖边界</summary><p>{watchData.coverage_note}</p><p>每周结合官方申请索引与新增公告/报道复核；不会将检索无结果解释为未终止，也不会将保密递交数量推算为全市场总量。未核实的募资额、保荐人及确切递表日不补猜值。</p><div className="summary-table-wrap"><table className="summary-table"><thead><tr><th>渠道</th><th>证据层级</th><th>用途与限制</th></tr></thead><tbody>{watchData.sources.map(s => <tr key={s.name}><td><SourceLink href={s.url} target="_blank" rel="noreferrer">{s.name} ↗</SourceLink></td><td>{s.tier}</td><td>{s.use}</td></tr>)}</tbody></table></div></details>
  </section>;
}
