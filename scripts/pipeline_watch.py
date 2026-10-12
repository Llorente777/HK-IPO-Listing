"""Evidence-qualified pipeline watch. Never relabel a lapse as an active application."""
from __future__ import annotations

import argparse
import calendar
import csv
import hashlib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
LABELS = {
    "public_active": "公开有效申请",
    "lapsed_continuing": "申请失效·公司披露仍推进",
    "lapsed_reported_continuing": "申请失效·据报仍推进",
    "lapsed_unverified": "申请失效·保留储备跟踪",
    "public_withdrawn": "申请撤回·计划待核实",
    "public_returned": "申请退回·计划待核实",
    "public_unverified": "曾公开递表·最新状态待核实",
    "confidential_reported": "据报保密递交·未获官方确认",
    "confidential_confirmed": "保密递交·公司或官方确认",
    "confidential_rumor": "市场传闻已密交·待核实",
    "confidential_planned": "拟／可能保密递交·未证实已递交",
}
CONFIDENTIAL_TIERS = {"tier1": "第一档·官方／权威来源", "tier2": "第二档·媒体／市场线索"}


def months_before(value, months):
    d = date.fromisoformat(value)
    total = d.year * 12 + d.month - 1 - months
    year, month = total // 12, total % 12 + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1])).isoformat()


def prospectus_dates(attempt, cutoff):
    """Only AP/revised AP/PHIP renew the watch clock, not coordinator notices."""
    docs = attempt.get("documents", [])
    ap = [d["date"] for d in docs if d.get("date") and d["date"] <= cutoff and any(s in d.get("document_type", "").upper() for s in ("申請版本", "申请版本", "APPLICATION PROOF"))]
    phip = [d["date"] for d in docs if d.get("date") and d["date"] <= cutoff and any(s in d.get("document_type", "").upper() for s in ("聆訊後資料集", "聆讯后资料集", "PHIP"))]
    # An inactive index can remove all document metadata. Use its original posting
    # date only in that case; never replace a typed AP date with a newer notice.
    if not docs:
        fallback = attempt.get("posting_date") or attempt.get("first_document_date")
        if fallback and fallback <= cutoff:
            ap.append(fallback)
    return ap, ap + phip


def confidential_tier(event):
    if event["kind"] == "confidential_confirmed" or (event["kind"] == "confidential_reported" and event.get("source_tier") == "authoritative"):
        return "tier1"
    return "tier2"


def identity(value):
    value = unicodedata.normalize("NFKC", value or "").lower()
    value = re.sub(r"\s*\((?:前称为?|前稱為?|曾用名|formerly).*\)\s*$", "", value)
    value = re.sub(r"(?:\s*[-—–]\s*(?:h\s*股|[bpswz]{1,3}))+\s*$", "", value)
    return re.sub(r"[\s()（）,，.。·•\-—–]", "", value)


def six_months(value):
    if not value:
        return None
    d = date.fromisoformat(value)
    month = d.month + 6
    year, month = d.year + (month - 1) // 12, (month - 1) % 12 + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1])).isoformat()


def validate_registry(registry, as_of):
    date.fromisoformat(registry["reviewed_at"])
    assert registry["reviewed_at"] <= as_of, "Evidence review cannot be future dated"
    for review in registry.get("termination_reviews", []):
        assert review["checked_at"] <= registry["reviewed_at"]
        assert review["conclusion"] in {"terminated", "no_termination_found_in_search", "needs_review"}
        assert review["query"] and review["scope"]
        assert all(urlparse(s["url"]).scheme == "https" for s in review["sources"])
    ids = set()
    for company in registry["companies"]:
        assert company["id"] not in ids, "Duplicate intelligence company"
        ids.add(company["id"])
        assert company["events"], "Missing evidence"
        for event in company["events"]:
            date.fromisoformat(event["date"])
            assert event["date"] <= registry["reviewed_at"], "Future evidence"
            assert event["kind"] in {"continuing", "confidential_reported", "confidential_confirmed", "confidential_rumor", "confidential_planned", "terminated", "denied"}
            assert event.get("source_tier") in {None, "authoritative", "market"}
            assert event["level"] in {"issuer", "regulator", "media"}
            assert event["kind"] not in {"confidential_confirmed", "terminated", "denied"} or event["level"] in {"issuer", "regulator"}, "Confirmation requires primary evidence"
            assert all(event.get(k) for k in ("publisher", "title", "summary", "url"))
            assert urlparse(event["url"]).scheme == "https" and urlparse(event["url"]).hostname


def build_watch(snapshot, universe, registry, as_of):
    validate_registry(registry, as_of)
    today = date.fromisoformat(as_of)
    start_date = registry.get("public_filing_start_date", "2023-02-17")
    assert registry.get("public_update_window_months", 12) == 12, "Expected 12-calendar-month reserve policy"
    cutoff = months_before(as_of, 12)
    date.fromisoformat(start_date)
    aliases = {}
    companies = {c["id"]: c for c in registry["companies"]}
    reviews = {identity(r["company_name"]): r for r in sorted(registry.get("termination_reviews", []), key=lambda r: r['checked_at'])}
    for c in companies.values():
        for name in [c["company_name"], *c.get("aliases", [])]:
            key = identity(name)
            assert key not in aliases or aliases[key] == c["id"], "Ambiguous company alias"
            aliases[key] = c["id"]

    # Exchange-disclosed former names are aliases, not new companies.
    official_aliases = {}
    for alias in registry.get("reviewed_name_aliases", []):
        assert alias["reviewed_at"] <= registry["reviewed_at"]
        assert alias["reason"] and urlparse(alias["evidence_url"]).scheme == "https"
        official_aliases[identity(alias["alias"])] = identity(alias["company_name"])
    all_official = snapshot["application_history"] + snapshot["active_applications"] + snapshot["listings"] + snapshot.get("excluded_non_ipo_listings", [])
    for r in all_official:
        full = unicodedata.normalize("NFKC", r["company_name"])
        renamed = re.match(r"^(.+?)\s*\((?:前称为?|前稱為?|曾用名[:：]?|formerly(?: known as)?)\s*(.+)\)\s*$", full, re.I)
        if renamed:
            official_aliases[identity(renamed[2])] = identity(renamed[1])

    def key(name):
        value = identity(name)
        seen = set()
        while value in official_aliases and value not in seen:
            seen.add(value)
            value = official_aliases[value]
        return aliases.get(value, value)

    histories = defaultdict(list)
    for r in snapshot["application_history"]:
        if (r.get("posting_date") or "") <= snapshot["snapshot_date"]:
            histories[key(r["company_name"])].append(r)
    active = {key(r["company_name"]) for r in snapshot["active_applications"]}
    active_ids = {str(r["application_id"]) for r in snapshot["active_applications"]}
    for r in snapshot["active_applications"]:
        group = histories[key(r["company_name"])]
        group[:] = [old for old in group if old["application_id"] != r["application_id"]]
        group.append(r)
    listed = {key(r["company_name"]): r for r in snapshot["listings"] + snapshot.get("excluded_non_ipo_listings", [])}
    a_by_code = {r["a_code"]: r for r in universe["records"]}
    verified_active = {str(r["application_id"]): r for r in snapshot.get("a_to_h_active", [])}
    a_by_name = defaultdict(list)
    for r in universe["records"]:
        a_by_name[identity(r["full_name"])].append(r)
    rows, resolved = [], []
    for company_key in sorted(set(histories) | set(companies)):
        attempts = sorted(histories.get(company_key, []), key=lambda r: (r.get("posting_date") or r.get("first_document_date") or "", r.get("latest_document_date") or "", str(r["application_id"])), reverse=True)
        latest = attempts[0] if attempts else None
        c = companies.get(company_key)
        events = sorted(c["events"], key=lambda e: e["date"]) if c else []
        last_event = events[-1] if events else None
        name = c["company_name"] if c else latest["company_name"]
        review = reviews.get(identity(name))
        # Keep re-filings inside public pipeline; remove completed/explicitly rejected plans.
        reason = "已上市" if company_key in listed else None
        if latest and latest["status_code"] in {"LT", "RJ"} and company_key not in active:
            reason = reason or f"最新官方状态：{latest.get('status', latest['status_code'])}"
        if last_event and last_event["kind"] in {"terminated", "denied"}:
            reason = "公司/官方已终止或否认相关计划"
        if reason:
            resolved.append({"id": company_key, "company_name": name, "reason": reason, "events": events, "termination_review": review,
                             "listing_evidence": {k: listed[company_key].get(k) for k in ("hk_code", "listing_date", "original_document_url", "source_url")} if company_key in listed else None,
                             "active_application_ids": sorted({str(r["application_id"]) for r in attempts} & active_ids)})
            continue
        # Display current fields from a current attempt, not a newer inactive index.
        if company_key in active:
            latest = next(r for r in attempts if str(r["application_id"]) in active_ids)
        application_dates, update_dates = [], []
        for attempt in attempts:
            ap_dates, version_dates = prospectus_dates(attempt, snapshot["snapshot_date"])
            application_dates.extend(ap_dates)
            update_dates.extend(version_dates)
        last_application = max(application_dates, default=None)
        last_update = max(update_dates, default=None)
        historical_public = bool(last_update and last_update >= start_date)
        eligible_public = company_key in active or bool(historical_public and last_update >= cutoff)
        is_lapsed = latest and latest["status_code"] == "LP" and company_key not in active
        status = None
        if eligible_public:
            status = "public_active" if company_key in active else {
                "LP": "lapsed_unverified", "W": "public_withdrawn", "RT": "public_returned",
            }.get(latest["status_code"], "public_unverified")
        lapse_estimate = six_months(last_application) if is_lapsed else None
        if eligible_public and is_lapsed and last_application and last_event and last_event["kind"] == "continuing" and last_event["date"] >= (lapse_estimate or last_application):
            status = "lapsed_reported_continuing" if last_event["level"] == "media" else "lapsed_continuing"
        secret_event = None
        if company_key not in active and events:
            candidates = [e for e in events if e["kind"].startswith("confidential_") and (not last_update or e["date"] > last_update)]
            if candidates:
                secret_event = max(candidates, key=lambda e: (e["kind"] == "confidential_confirmed", confidential_tier(e) == "tier1", e["date"]))
                status = secret_event["kind"]
        if not status:
            if historical_public and last_update < cutoff:
                resolved.append({"id": company_key, "company_name": name, "reason": "招股书超过12个月未更新·移出当前储备（非终止认定）", "last_prospectus_update_date": last_update, "events": events, "termination_review": review})
            continue
        match = None
        if c and c.get("a_code"):
            match = a_by_code.get(c["a_code"])
            assert match and identity(match["full_name"]) in {identity(name), *[identity(a) for a in c.get("aliases", [])]}, "A code/name mismatch"
        else:
            candidates = a_by_name.get(identity(name), [])
            match = candidates[0] if len(candidates) == 1 else None
            checked = verified_active.get(str(latest["application_id"])) if latest else None
            if not match and checked and key(checked["company_name"]) == company_key:
                match = a_by_code.get(checked["a_code"])
        first = min(application_dates, default=None)
        selected_event = secret_event or last_event
        evidence_date = selected_event["date"] if selected_event else None
        age = (today - date.fromisoformat(evidence_date)).days if evidence_date else None
        bucket = "confidential" if status.startswith("confidential_") else "public"
        default_note = ("当前公开AP/PHIP索引中的申请，已计入原有公开申请统计；在储备池按公司去重，不重复相加。" if status == "public_active" else
                        review["note"] if review else "按2023年2月17日起曾递表且最近12个月有招股书更新的研究口径保留；该公司终止公告尚待专项检索。保留跟踪不代表仍在审或已证实继续推进。")
        tier = confidential_tier(secret_event) if secret_event else None
        rows.append({
            "id": company_key, "company_name": name, "aliases": c.get("aliases", []) if c else [],
            "bucket": bucket, "status": status, "status_label": LABELS[status], "is_a_to_h": bool(match),
            "a_code": match["a_code"] if match else None, "a_exchange": match["exchange"] if match else None,
            "a_short_name": match["short_name"] if match else None, "a_official_url": match["official_url"] if match else None,
            "a_industry": match.get("industry") if match else None,
            "first_application_date": first, "last_application_date": last_application,
            "last_prospectus_update_date": last_update,
            "confidential_tier": tier, "confidential_tier_label": CONFIDENTIAL_TIERS.get(tier),
            "classification_source": selected_event if bucket == "confidential" else None,
            "application_id": latest["application_id"] if latest else None,
            "active_application_ids": sorted({str(r["application_id"]) for r in attempts} & active_ids),
            "attempt_count": len({r["application_id"] for r in attempts}),
            "official_status": latest.get("status") if latest else "未在本期公开索引中核实",
            "official_url": latest.get("warning_url") if latest else None,
            "estimated_lapse_date": lapse_estimate, "evidence_date": evidence_date,
            "evidence_age_days": age, "needs_review": age is None or age > 90,
            "events": events,
            "termination_review": review,
            "note": selected_event["summary"] if selected_event else default_note,
        })
    order = {"lapsed_continuing": 0, "lapsed_reported_continuing": 1, "confidential_confirmed": 2, "confidential_reported": 3, "confidential_rumor": 3, "confidential_planned": 3, "public_active": 4, "lapsed_unverified": 5, "public_withdrawn": 6, "public_returned": 7, "public_unverified": 8}
    rows.sort(key=lambda r: (order[r["status"]], -(date.fromisoformat(r["evidence_date"] or r["last_prospectus_update_date"]).toordinal())))
    return {"schema_version": 3, "public_filing_start_date": start_date, "public_update_cutoff": cutoff, "public_update_window_months": 12, "generated_as_of": as_of, "official_snapshot_date": snapshot["snapshot_date"],
            "confidential_tier_labels": CONFIDENTIAL_TIERS, "confidential_tier_counts": dict(Counter(r["confidential_tier"] for r in rows if r["bucket"] == "confidential")),
            "evidence_reviewed_at": registry["reviewed_at"], "coverage_note": registry["coverage_note"],
            "counts": dict(Counter(r["status"] for r in rows)), "bucket_counts": dict(Counter(r["bucket"] for r in rows)), "rows": rows, "resolved": resolved,
            "sources": registry["sources"], "labels": LABELS,
            "termination_review_count": len(reviews)}


def write_outputs(payload, root=ROOT, archive=True):
    folder = root / "public/data"
    folder.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    (folder / "pipeline_watch.json").write_text(encoded, encoding="utf-8")
    (root / "data/processed").mkdir(parents=True, exist_ok=True)
    (root / "data/processed/pipeline_watch.json").write_text(encoded, encoding="utf-8")
    fields = ["company_name", "bucket", "status_label", "confidential_tier_label", "a_code", "a_exchange", "first_application_date", "last_application_date", "last_prospectus_update_date", "application_id", "attempt_count", "official_status", "estimated_lapse_date", "evidence_date", "needs_review", "note", "official_url", "a_official_url", "classification_publisher", "classification_url", "evidence_sources", "evidence_urls"]
    for name, rows in [("pipeline_watch.csv", payload["rows"]), ("a_to_h_watch.csv", [r for r in payload["rows"] if r["is_a_to_h"]])]:
        with (folder / name).open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow({**row, "classification_publisher": (row["classification_source"] or {}).get("publisher"), "classification_url": (row["classification_source"] or {}).get("url"), "evidence_sources": " | ".join(f"{e['date']} {e['publisher']} {e['title']}" for e in row["events"]), "evidence_urls": " | ".join(e["url"] for e in row["events"])})
    if not archive:
        return
    archive_folder = root / "data/snapshots/pipeline-watch"
    archive_folder.mkdir(parents=True, exist_ok=True)
    name = f"{payload['generated_as_of']}--{hashlib.sha256(encoded.encode()).hexdigest()[:12]}.json"
    path = archive_folder / name
    if not path.exists():
        with path.open("x", encoding="utf-8") as handle:
            handle.write(encoded)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", default=date.today().isoformat())
    args = parser.parse_args()
    read = lambda p: json.loads((ROOT / p).read_text(encoding="utf-8"))
    payload = build_watch(read("data/processed/full_snapshot.json"), read("data/processed/a_share_official_universe.json"), read("data/reference/pipeline_intelligence.json"), args.as_of)
    write_outputs(payload)
    print(json.dumps({"watch_companies": len(payload["rows"]), "a_to_h": sum(r["is_a_to_h"] for r in payload["rows"]), "counts": payload["counts"]}))


if __name__ == "__main__":
    main()
