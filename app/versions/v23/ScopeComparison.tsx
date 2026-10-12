import { SourceLink } from './SourceLink';
import dashboard from './dashboard.json';

export function ScopeComparison() {
  const p = dashboard.official_processing_statistics[0];
  return <section className="scope-reference" aria-label="官方口径对照">
    <div className="scope-reference-top"><div><span>官方监管统计 · {p.as_of}</span><strong>{p.under_processing_total} <small>宗审核处理中</small></strong></div><div><span>本站公开索引 · {dashboard.snapshot_date}</span><strong>{dashboard.active_application_count} <small>宗 / {dashboard.active_application_scope.unique_company_names} 家</small></strong></div><SourceLink href={p.source_url} target="_blank" rel="noreferrer">港交所原月报 ↗</SourceLink></div>
    <p>两者并非同日、同范围统计。不能用储备项目补齐差额，也不能据此推定遗漏了哪些公司。</p>
    <details><summary>为什么不同？查看已核实的规则与尚未解决的差额</summary>
      <ul><li>月报按监管申请宗数统计；公开索引按申请ID去重，本站公司表进一步合并同一公司的多个ID。</li><li>月报包含投资工具、转板、De-SPAC继承公司、视作新申请人及反向收购等类别。续期申请在失效后三个月内重新受理，月报可作为原申请延续。</li><li>公开AP / PHIP不是完整监管名册；保密递交制度允许不公开申请版本，但不能由此断言差额全部属于密交。</li></ul>
      <p><b>本次核查结论：</b>2026年8月月报将511宗处理中、23宗获批待上市、197宗其他状态（含失效、退回、拒绝、撤回）分开列示。因此“公开申请＋失效储备＝官方在审”没有依据。原月报只有分类汇总，没有可供逐家配对的511宗完整名单，暂不能识别全部差额公司。</p>
      <p>2026年8月21日起，符合条件的新申请有效期可延长至12个月。网站以官方索引状态为准，不凭六个月日历自动判定失效；这也不等于研究观察池的“一年招股书更新窗口”。<SourceLink href="https://www.hkex.com.hk/News/Regulatory-Announcements/2026/260821news?sc_lang=en" target="_blank" rel="noreferrer">有效期公告 ↗</SourceLink> · <SourceLink href="https://www.hkex.com.hk/News/Regulatory-Announcements/2026/260724news?sc_lang=en" target="_blank" rel="noreferrer">保密递交规则 ↗</SourceLink></p>
      <small>规则与月报复核：2026-09-25。未获得同日完整监管名单前，不提供伪精确的公司差额清单。</small>
    </details>
  </section>;
}
