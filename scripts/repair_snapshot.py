"""Re-derive research views from saved official evidence; never claim a fresh fetch.

Preserves source dates and original archives. Rolls current artifacts back on failure.
"""
import argparse
import csv
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from hkex_pipeline import rebuild_research_outputs, retain_prior_application_history, write_csv, write_json
from pipeline_analytics import build_analytics, write_analytics
from pipeline_watch import write_outputs

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--retain-prior-history', action='store_true')
    parser.add_argument('--reason', default='复合公司后缀识别修正；已上市排除、研究名单与保荐人一致性重建')
    args = parser.parse_args()
    read = lambda p: json.loads((ROOT / p).read_text(encoding='utf-8'))
    snapshot = read('data/processed/full_snapshot.json')
    dashboard = read('data/processed/dashboard.json')
    universe = read('data/processed/a_share_official_universe.json')
    registry = read('data/reference/pipeline_intelligence.json')
    previous_analytics = read('public/data/pipeline_analytics.json')
    # Only carry dated market facts, never entire rows which could overwrite classification.
    market = {r['a_code']: {k:r.get(k) for k in ('a_market_cap_rmb_bn','market_data_date','market_data_source_url')}
              for r in previous_analytics['rows'] if r.get('a_code')}
    files = [ROOT/p for p in ('data/processed/full_snapshot.json','data/processed/dashboard.json',
             'data/processed/pipeline_watch.json','data/processed/pipeline_analytics.json')]
    files += list((ROOT/'public/data').glob('*.*'))
    backup = {p:p.read_bytes() for p in files if p.is_file()}
    parent_hash = hashlib.sha256((ROOT/'data/processed/full_snapshot.json').read_bytes()).hexdigest()
    corrected_at = datetime.now(timezone.utc).isoformat()
    try:
        if args.retain_prior_history:
            paths = sorted((p for p in (ROOT/'data/snapshots').glob('????-??-??*.json') if p.name[:10] < snapshot['snapshot_date']), key=lambda p: json.loads(p.read_text(encoding='utf-8')).get('generated_at', ''), reverse=True)
            previous = json.loads(paths[0].read_text(encoding='utf-8')) if paths else None
            snapshot['application_history'] = retain_prior_application_history(snapshot['application_history'],snapshot['active_applications'],previous,snapshot['snapshot_date'])
            snapshot['coverage']['application_history_records'] = len(snapshot['application_history'])
            dashboard['coverage']['application_history_records'] = len(snapshot['application_history'])
            for count in dashboard.get('yearly_application_counts', []):
                count['count'] = sum(r.get('observed_year') == count['year'] for r in snapshot['application_history'])
        watch = rebuild_research_outputs(snapshot,dashboard,universe,registry,snapshot['snapshot_date'])
        for target in (snapshot,dashboard):
            target['research_correction'] = {'corrected_at':corrected_at,'parent_sha256':parent_hash,
                'reason':args.reason,
                'fresh_official_fetch':False}
        analytics = build_analytics(watch,snapshot,universe['records'],market)
        write_analytics(analytics)
        for name,payload in [('full_snapshot',snapshot),('dashboard',dashboard)]:
            write_json(ROOT/f'data/processed/{name}.json',payload)
            write_json(ROOT/f'public/data/{name}.json',payload,compact=True)
        with (ROOT/'public/data/a_to_h.csv').open(encoding='utf-8-sig',newline='') as f:
            fields = next(csv.reader(f))
        write_csv(ROOT/'public/data/a_to_h.csv',snapshot['a_to_h_listed']+snapshot['research_a_to_h_active'],fields)
        subprocess.run([os.environ.get('NODE_BINARY','node'),'scripts/data-validate.mjs'],cwd=ROOT,check=True)
    except Exception:
        for path,content in backup.items(): path.write_bytes(content)
        raise
    payload = (ROOT/'data/processed/full_snapshot.json').read_bytes()
    digest = hashlib.sha256(payload).hexdigest()[:12]
    stamp = ''.join(c for c in corrected_at if c.isdigit())
    archive = ROOT/f"data/snapshots/{snapshot['snapshot_date']}--{stamp}--{digest}.json"
    with archive.open('xb') as f: f.write(payload)
    write_outputs(watch)
    latest = ROOT/'data/snapshots/latest.json'
    temp = latest.with_suffix('.json.tmp')
    temp.write_bytes(payload); temp.replace(latest)
    print(json.dumps({'archive':str(archive),'research_active':len(snapshot['research_active_applications']),
                     'watch':len(watch['rows']),'conflicts':len(snapshot['active_state_conflicts']),
                     'reserve_sponsors':sum(bool(r['sponsors']) for r in analytics['rows'] if r['category']=='reserve'),
                     'reserve_documents':sum(bool(r['prospectus_url']) for r in analytics['rows'] if r['category']=='reserve')}))


if __name__ == '__main__': main()
