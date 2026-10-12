"""Derived company-level pipeline analytics; missing facts remain null.

Public status always comes from the saved official snapshot, not elapsed time.
Market dates and sources are carried independently of the application date.
"""
import argparse
import csv
import hashlib
import json
from datetime import date
from pathlib import Path
from pipeline_watch import identity
from hkex_pipeline import (Fetcher, fetch_a_share_market_data, apply_a_share_model,
                           MODEL_HA_DISCOUNT_PCT, MODEL_ISSUE_RATIO_PCT, MODEL_GREENSHOE_PCT)

ROOT = Path(__file__).resolve().parents[1]


def historical_evidence(directory, as_of):
    """Merge dated, same-ID evidence without allowing later empty rows to erase it."""
    result = {}
    snapshots = []
    for path in directory.glob('????-??-??*.json'):
        if path.name[:10] > as_of: continue
        old = json.loads(path.read_text(encoding='utf-8'))
        if old.get('snapshot_date', '9999') <= as_of:
            snapshots.append((old.get('generated_at') or old['snapshot_date'], path.name, old))
    for _, _, old in sorted(snapshots, key=lambda item: item[:2]):
        for a in old.get('active_applications', []):
            app_id = str(a['application_id'])
            former = result.get(app_id, {})
            if former and identity(former['company_name']) != identity(a['company_name']):
                raise ValueError('Historical application ID/company conflict: ' + app_id)
            merged = {**former, 'company_name': a['company_name']}
            if a.get('sponsors') and a.get('sponsor_source_url'):
                merged.update(sponsors=a['sponsors'], sponsor_source_url=a['sponsor_source_url'])
            docs = {d.get('full_document_url'): d for d in former.get('documents', []) + a.get('documents', [])
                    if d.get('full_document_url') and d.get('date', '9999') <= as_of}
            merged['documents'] = list(docs.values())
            result[app_id] = merged
    return result


def build_analytics(watch, snapshot, universe, market):
    attempts = {str(r['application_id']): r for r in snapshot['application_history']}
    attempts.update({str(r['application_id']): r for r in snapshot['active_applications']})
    active = {str(r['application_id']): r for r in snapshot['a_to_h_active']}
    history_sponsors = historical_evidence(ROOT / 'data/snapshots', snapshot['snapshot_date'])
    result = []
    for r in watch['rows']:
        a = attempts.get(str(r['application_id']), {})
        if r['status'] != 'public_active' and r['bucket'] == 'public':
            former = history_sponsors.get(str(r['application_id']), {})
            if former and identity(former['company_name']) == identity(a.get('company_name')):
                if not a.get('sponsors'):
                    a = {**a, 'sponsors': former.get('sponsors', []), 'sponsor_source_url': former.get('sponsor_source_url')}
                if not a.get('documents'):
                    a = {**a, 'documents': former.get('documents', [])}
        known = active.get(str(r['application_id']), {}) if r['status'] == 'public_active' else {}
        docs = [d for d in a.get('documents', []) if any(x in d.get('document_type', '').upper() for x in ('申請版本', '申请版本', 'APPLICATION PROOF', 'PHIP', '聆訊後', '聆讯后')) and d.get('full_document_url')]
        docs.sort(key=lambda d: d.get('date', ''), reverse=True)
        # A historical public sponsor is not proof of a current confidential mandate.
        sponsors = list(dict.fromkeys(a.get('sponsors', []))) if r['bucket'] != 'confidential' else []
        row = {**r, 'category': 'active' if r['status'] == 'public_active' else 'confidential' if r['bucket'] == 'confidential' else 'reserve',
               'sponsors': sponsors, 'sponsor_basis': '当前公开申请' if r['status'] == 'public_active' else '历史公开披露，是否续任待核' if sponsors else '未核实',
               'sponsor_source_url': a.get('sponsor_source_url'), 'market': a.get('market'),
               'has_phip': bool(a.get('has_phip')) if r['status'] == 'public_active' else False,
               'prospectus_url': docs[0]['full_document_url'] if docs else None,
               'a_market_cap_rmb_bn': known.get('a_market_cap_rmb_bn'), 'market_data_date': known.get('market_data_date'),
               'market_data_source_url': known.get('market_data_source_url')}
        if r['a_code'] and not known:
            row.update(market.get(r['a_code'], {}))
        apply_a_share_model([row], {})
        result.append(row)
    assert len({r['id'] for r in result}) == len(result)
    return {'official_snapshot_date': snapshot['snapshot_date'], 'watch_as_of': watch['generated_as_of'],
            'evidence_reviewed_at': watch['evidence_reviewed_at'],
            'model_assumptions': {'ha_discount_pct': MODEL_HA_DISCOUNT_PCT, 'issue_ratio_pct': MODEL_ISSUE_RATIO_PCT, 'greenshoe_pct': MODEL_GREENSHOE_PCT},
            'rows': result}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fetch-missing', action='store_true')
    parser.add_argument('--refresh-market', action='store_true', help='Refresh reserve market data; abort on incomplete response')
    args = parser.parse_args()
    read = lambda p: json.loads((ROOT / p).read_text(encoding='utf-8'))
    watch = read('public/data/pipeline_watch.json')
    snapshot = read('data/processed/full_snapshot.json')
    universe = read('data/processed/a_share_official_universe.json')['records']
    codes = {r['a_code'] for r in watch['rows'] if r['a_code']}
    fetcher = Fetcher()
    market = fetch_a_share_market_data(fetcher, universe, codes, date.fromisoformat(snapshot['snapshot_date']), reuse_sse_cache=True, reuse_szse_cache=True)
    missing = codes - market.keys()
    if args.refresh_market:
        active_codes = {r['a_code'] for r in snapshot['a_to_h_active']}
        reserve_codes = codes - active_codes
        fresh = fetch_a_share_market_data(fetcher, universe, reserve_codes, date.fromisoformat(snapshot['snapshot_date']))
        if reserve_codes - fresh.keys():
            raise RuntimeError('Incomplete official reserve market refresh: ' + ','.join(sorted(reserve_codes - fresh.keys())))
        market.update(fresh)
    if args.fetch_missing and missing:
        market.update(fetch_a_share_market_data(fetcher, universe, missing, date.today(), reuse_szse_cache=True))
    payload = build_analytics(watch, snapshot, universe, market)
    write_analytics(payload)
    ah = [r for r in payload['rows'] if r['a_code']]
    print(json.dumps({'companies':len(payload['rows']), 'ah':len(ah), 'market_coverage':sum(r['a_market_cap_rmb_bn'] is not None for r in ah), 'missing':[r['a_code'] for r in ah if r['a_market_cap_rmb_bn'] is None]}))


def write_analytics(payload):
    encoded = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
    (ROOT / 'public/data/pipeline_analytics.json').write_text(encoded, encoding='utf-8')
    (ROOT / 'data/processed/pipeline_analytics.json').write_text(encoded, encoding='utf-8')
    fields = ['company_name','category','status_label','confidential_tier_label','a_code','a_exchange','a_market_cap_rmb_bn','market_data_date','market_data_source_url','a_market_cap_band','estimated_h_valuation_rmb_bn','estimated_base_issue_rmb_bn','estimated_max_issue_rmb_bn','sponsors','sponsor_basis','sponsor_source_url','prospectus_url','a_official_url']
    with (ROOT / 'public/data/pipeline_analytics.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore'); writer.writeheader()
        for row in payload['rows']:
            writer.writerow({**row, 'sponsors': ' / '.join(row['sponsors'])})
    archive = ROOT / 'data/snapshots/pipeline-analytics'
    archive.mkdir(parents=True, exist_ok=True)
    dest = archive / (payload['watch_as_of'] + '--' + hashlib.sha256(encoded.encode()).hexdigest()[:12] + '.json')
    if not dest.exists(): dest.write_text(encoded, encoding='utf-8')


if __name__ == '__main__': main()
