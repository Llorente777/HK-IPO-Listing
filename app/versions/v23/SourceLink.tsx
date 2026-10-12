import type { AnchorHTMLAttributes } from 'react';
import audit from './link_audit.json';
const checks=new Map(audit.rows.map(r=>[r.url,r]));
export function SourceLink({href,children,...props}:AnchorHTMLAttributes<HTMLAnchorElement>) {
  if(!href) return <span className="source-unavailable">{children}（暂无链接）</span>;
  const checked=checks.get(href);
  const label=checked?.status==='restricted'?'访问受限':checked?.status==='unexpected_content'?'内容类型待核':checked?.status==='not_verified'?(checked.http===404?'原链接404':'访问未验证'):null;
  return <><a href={href} {...props}>{children}</a>{label&&<small className="source-link-warning" title={`访问检查 ${audit.checked_at}；保留原始地址，不代表原披露内容失实。`}>{label} · {audit.checked_at.slice(0,10)}</small>}</>;
}
export function LinkAuditSummary() {
  const unavailable=audit.rows.filter(r=>r.status!=='reachable');
  return <section className="summary-block"><div className="summary-heading"><h2>来源链接检查</h2><a href="/versions/v23/data/link_audit.json" download>下载检查结果 JSON ↓</a></div><p className="table-note">{audit.checked_at.replace('T',' ')}：检查 {audit.total} 个来源地址，{audit.reachable} 个可访问，{unavailable.length} 个受限或未通过。PDF检查包括文件签名；可访问不等于逐页内容已全部核实。范围包括历史终止检索命中链接，数字不是公司家数。</p><details className="watch-sources"><summary>查看未通过原因与原始地址</summary><div className="summary-table-wrap"><table className="summary-table"><thead><tr><th>原始地址</th><th>访问状态</th></tr></thead><tbody>{unavailable.map(r=><tr key={r.url}><td><a href={r.url} target="_blank" rel="noreferrer">{r.url}</a></td><td>{r.status==='restricted'?'访问受限':r.http===404?'404：地址不存在或已撤下':'未能验证'}{r.http?`（${r.http}）`:''}</td></tr>)}</tbody></table></div></details></section>;
}
