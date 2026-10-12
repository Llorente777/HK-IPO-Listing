"use client";

export type ChartPoint = { label: string; value: number };

export function Bars({ data, suffix = "", max }: { data: ChartPoint[]; suffix?: string; max?: number }) {
  const ceiling = max ?? Math.max(...data.map((item) => item.value), 1);
  return (
    <div className="bars" role="img" aria-label="数据柱状图">
      {data.map((item) => (
        <div className="bar-row" key={item.label}>
          <span>{item.label}</span>
          <div className="bar-track"><i style={{ width: `${Math.max((item.value / ceiling) * 100, 3)}%` }} /></div>
          <b>{item.value}{suffix}</b>
        </div>
      ))}
    </div>
  );
}

export function Donut({ value, label }: { value: number; label: string }) {
  return (
    <div className="donut-wrap">
      <div className="donut" style={{ background: `conic-gradient(#c9a35d 0 ${value}%, #d9d7cf ${value}% 100%)` }}>
        <div><b>{value}%</b><span>{label}</span></div>
      </div>
      <div className="legend"><span><i className="gold" />A→H</span><span><i />非A→H</span></div>
    </div>
  );
}

export function Funnel() {
  const items = [
    ["官方筹划", "待补证", 100], ["已递表", "待补证", 78], ["已备案", "待补证", 60],
    ["PHIP / 聆讯后", "待补证", 42], ["已上市", "待补证", 26],
  ] as const;
  return (
    <div className="funnel" aria-label="A到H项目状态漏斗">
      {items.map(([label, value, width]) => <div style={{ width: `${width}%` }} key={label}><span>{label}</span><b>{value}</b></div>)}
    </div>
  );
}
