import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const candidates = [process.env.PYTHON,
  join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe"),
  "python", "python3", "py"].filter(Boolean);
// A launcher/version check alone does not establish usable PDF extraction.
const executable = candidates.find((candidate) => spawnSync(candidate, ["-c",
  "import importlib.util; assert any(importlib.util.find_spec(m) for m in ('fitz','pdfplumber','pypdf')), 'PDF extraction dependencies missing'"
], { encoding: "utf8" }).status === 0);
if (!executable) throw new Error("官方数据更新失败：未找到可读取招股书PDF的 Python 3 环境");
console.log("Official collector runtime: " + executable);

// Preserve successful normalized data on failure. Keep downloaded evidence for diagnostics.
const targets = ["data/raw_manifest.json", "data/processed/full_snapshot.json", "data/processed/dashboard.json",
  ...["pipeline_watch.json", "pipeline_analytics.json", "link_audit.json"].map((name)=>"data/processed/"+name),
  "data/processed/a_share_official_universe.json", "public/data/research_active_applications.csv",
  ...["dashboard.json", "full_snapshot.json", "listed_ipos.csv", "active_applications.csv", "excluded_non_ipo_listings.csv", "a_to_h.csv", "a_to_h_exclusions.csv", "pipeline_watch.json", "pipeline_watch.csv", "a_to_h_watch.csv", "pipeline_analytics.json", "pipeline_analytics.csv"].map((name) => "public/data/" + name)];
const backup = new Map(targets.map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
let stage = 'official_collection';
try {
  const result = spawnSync(executable, ["scripts/hkex_pipeline.py"], {
    stdio: "inherit", env: { ...process.env, HKIPO_FORCE_REFRESH: process.env.HKIPO_FORCE_REFRESH ?? "1", NODE_BINARY: process.execPath },
  });
  if (result.status !== 0) throw new Error("官方采集失败，退出码 " + result.status);
  stage = 'reserve_market_analytics';
  const analytics = spawnSync(executable, ["scripts/pipeline_analytics.py", "--refresh-market"], { stdio: "inherit", env: { ...process.env, HKIPO_FORCE_REFRESH: "1" } });
  if (analytics.status !== 0) throw new Error("储备测算生成失败");
  stage = 'client_data_sync';
  const clientData = spawnSync(process.execPath, ["scripts/sync-client-data.mjs"], {stdio:"inherit"});
  if (clientData.status !== 0) throw new Error("页面与下载数据同步失败");
  stage = 'data_validation';
  const validation = spawnSync(process.execPath, ["scripts/data-validate.mjs"], { stdio: "inherit" });
  if (validation.status !== 0) throw new Error("数据校验失败");
  stage = 'immutable_snapshot';
  const watchPayload = readFileSync("public/data/pipeline_watch.json");
  const watch = JSON.parse(watchPayload.toString("utf8"));
  const watchHash = createHash("sha256").update(watchPayload).digest("hex").slice(0, 12);
  mkdirSync("data/snapshots/pipeline-watch", { recursive: true });
  const watchArchive = `data/snapshots/pipeline-watch/${watch.generated_as_of}--${watchHash}.json`;
  if (!existsSync(watchArchive)) writeFileSync(watchArchive, watchPayload, { flag: "wx" });
  const payload = readFileSync("data/processed/full_snapshot.json");
  const snapshot = JSON.parse(payload.toString("utf8"));
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 12);
  const stamp = snapshot.generated_at.replace(/[^0-9]/g, "");
  mkdirSync("data/snapshots", { recursive: true });
  const immutable = "data/snapshots/" + snapshot.snapshot_date + "--" + stamp + "--" + hash + ".json";
  writeFileSync(immutable, payload, { flag: "wx" });
  const daily = "data/snapshots/" + snapshot.snapshot_date + ".json";
  if (!existsSync(daily)) writeFileSync(daily, payload, { flag: "wx" });
  writeFileSync("data/snapshots/latest.json.tmp", payload);
  renameSync("data/snapshots/latest.json.tmp", "data/snapshots/latest.json");
  console.log("Validated immutable snapshot saved: " + immutable);
} catch (error) {
  // Keep failure diagnostics outside the normalized files restored below.
  // The restored raw_manifest belongs to the previous successful snapshot.
  const diagnosticDir = join('outputs', 'update-failures', new Date().toISOString().replace(/[^0-9]/g, ''));
  try {
    mkdirSync(diagnosticDir, { recursive: true });
    writeFileSync(join(diagnosticDir, 'failure.json'), JSON.stringify({
      status: 'failed_not_publishable', stage, failed_at: new Date().toISOString(),
      message: error.message, previous_data_will_be_restored: true,
      request_evidence: 'data/raw/run-attempts; source errors also remain in job logs',
    }, null, 2) + '\n', { flag: 'wx' });
  } catch (diagnosticError) { console.error('Failure diagnostic could not be saved: ' + diagnosticError.message); }
  for (const [path, content] of backup) {
    if (content === null) { if (existsSync(path)) rmSync(path); }
    else writeFileSync(path, content);
  }
  throw new Error(error.message + "；已保留上一成功数据，未推进快照。", { cause: error });
}
