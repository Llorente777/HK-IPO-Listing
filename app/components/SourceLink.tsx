import type { AnchorHTMLAttributes } from 'react';
import audit from '@/data/processed/link_audit.json';
const checks=new Map(audit.rows.map(r=>[r.url,r]));
export function SourceLink({href,children,...props}:AnchorHTMLAttributes<HTMLAnchorElement>) {
  if(!href) return <span className="source-unavailable">{children}（暂无链接）</span>;
  const checked=checks.get(href);
  const checkedAt=checked?.checked_at||audit.checked_at;
  if(checked?.http===404){
    const hkex=/^https:\/\/[^/]*hkex(?:news)?\.hk\//i.test(href);
    const search='https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=zh';
    return <span className="source-unavailable" title={`原地址（保留作审计，已返回404）：${href}`}><span>{children}</span><small className="source-link-warning">原文件地址已失效 · {checkedAt.slice(0,10)}</small>{hkex&&checks.get(search)?.status==='reachable'&&<a href={search} target="_blank" rel="noreferrer">转到披露易检索（非原文件） ↗</a>}</span>;
  }
  const label=checked?.status==='restricted'?'访问受限':checked?.status==='unexpected_content'?'内容类型待核':checked?.status==='not_verified'?(checked.http===404?'原链接404':'访问未验证'):null;
  return <><a href={href} {...props}>{children}</a>{label&&<small className="source-link-warning" title={`访问检查 ${checkedAt}；保留原始地址，不代表原披露内容失实。`}>{label} · {checkedAt.slice(0,10)}</small>}</>;
}
export function LinkAuditSummary() {
  const unavailable=audit.rows.filter(r=>r.status!=='reachable');
  return <section className="summary-block"><div className="summary-heading"><h2>来源链接检查</h2><a href="/data/link_audit.json" download>下载检查结果 JSON ↓</a></div><p className="table-note">累计检查 {audit.total} 个来源地址（汇总生成：{audit.checked_at.replace('T',' ')}；非当日全量复查），{audit.reachable} 个可访问，{unavailable.length} 个受限或未通过。PDF检查包括文件签名；可访问不等于逐页内容已全部核实。范围包括历史终止检索命中链接，数字不是公司家数。</p><details className="watch-sources"><summary>查看未通过原因与原始地址</summary><div className="summary-table-wrap"><table className="summary-table"><thead><tr><th>原始地址</th><th>访问状态</th><th>实际检查日期</th></tr></thead><tbody>{unavailable.map(r=><tr key={r.url}><td>{r.http===404?<code className="raw-source-url">{r.url}</code>:<a href={r.url} target="_blank" rel="noreferrer">{r.url}</a>}</td><td>{r.status==='restricted'?'访问受限':r.http===404?'404：地址不存在或已撤下':'未能验证'}{r.http?`（${r.http}）`:''}</td><td>{r.checked_at||'未记录'}</td></tr>)}</tbody></table></div></details></section>;
}
