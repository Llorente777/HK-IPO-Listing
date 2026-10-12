import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboard = JSON.parse(await readFile(new URL("../data/processed/dashboard.json", import.meta.url), "utf8"));

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("renders the production monitoring dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /港股IPO情况汇总/);
  assert.match(html, /官方周度快照/);
  assert.match(html, /本周信息更新/);
  assert.ok(html.includes(`<strong>${dashboard.current_year.ipo_count}</strong>`));
  assert.ok(html.includes(`<strong>${dashboard.research_a_to_h_active.length}</strong>`));
  assert.ok(html.includes(`<strong>${dashboard.official_processing_statistics[0].under_processing_total}`));
  assert.ok(html.includes(dashboard.snapshot_date));
  assert.match(html, /HKEXnews/);
  assert.doesNotMatch(html, /Mock Data|Demo Data|Lorem Ipsum|codex-preview/);
});

test("renders the frozen version 22 independently", async () => {
  const response = await render('/versions/v22');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /第22版历史样例/);
  assert.match(html, /页面与数据冻结/);
  assert.match(html, /港股IPO情况汇总/);
  assert.match(html, /\/versions\/v22\/data\//);
});

test('renders frozen version 23 and real production export routes',async()=>{
  const response=await render('/versions/v23');assert.equal(response.status,200);
  const html=await response.text();assert.match(html,/第23版历史样例/);assert.match(html,/\/versions\/v23\/data\//);
  for(const dataset of ['ipo','applications','pipeline','watch','ah-listed']) {
    const csv=await render(`/api/export?dataset=${dataset}&rows=0`);assert.equal(csv.status,200);
    assert.match(csv.headers.get('content-disposition'),/attachment/);assert.equal((await csv.text()).split('\r\n').length,2);
  }
  assert.equal((await render('/api/export?dataset=ipo&rows=999999')).status,400);
  assert.equal((await render('/this-page-does-not-exist')).status,404);
});
