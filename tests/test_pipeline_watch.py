import json
import unittest
from pathlib import Path
from scripts.pipeline_watch import build_watch, identity, six_months, months_before


class PipelineWatchRules(unittest.TestCase):
    def setUp(self):
        self.snapshot = {"snapshot_date": "2026-09-22", "application_history": [], "active_applications": [], "listings": [], "excluded_non_ipo_listings": []}
        self.registry = {"reviewed_at": "2026-09-23", "coverage_note": "test", "companies": [], "sources": []}
        self.universe = {"records": []}

    def row(self, name="测试股份有限公司", status="LP", day="2026-01-02", app_id="1"):
        return {"company_name": name, "status_code": status, "status": status, "posting_date": day, "first_document_date": day, "application_id": app_id}

    def event(self, kind="continuing", level="issuer", day="2026-07-04"):
        return {"kind": kind, "level": level, "date": day, "publisher": "issuer", "title": "title", "summary": "summary", "url": "https://example.com/evidence"}

    def company(self, event=None):
        return {"id": "test", "company_name": "测试股份有限公司", "aliases": [], "a_code": None, "events": [event or self.event()]}

    def build(self):
        return build_watch(self.snapshot, self.universe, self.registry, "2026-09-23")

    def test_lapse_does_not_imply_continuing(self):
        self.snapshot["application_history"] = [self.row()]
        self.assertEqual(self.build()["rows"][0]["status"], "lapsed_unverified")

    def test_explicit_post_lapse_evidence_confirms_intent(self):
        self.snapshot["application_history"] = [self.row()]
        self.registry["companies"] = [self.company()]
        self.assertEqual(self.build()["rows"][0]["status"], "lapsed_continuing")

    def test_pre_lapse_statement_does_not_confirm_continuing_after_lapse(self):
        self.snapshot["application_history"] = [self.row()]
        self.registry["companies"] = [self.company(self.event(day="2026-06-01"))]
        self.assertEqual(self.build()["rows"][0]["status"], "lapsed_unverified")

    def test_listed_leave_pipeline(self):
        for field in ["listings", "excluded_non_ipo_listings"]:
            self.setUp()
            self.snapshot["application_history"] = [self.row()]
            self.snapshot[field] = [self.row()]
            self.assertEqual(self.build()["rows"], [])

    def test_composite_listing_suffix_excludes_stale_active_record_with_evidence(self):
        self.assertEqual(identity('真健康 - B - H 股'), identity('真健康 - B'))
        self.assertNotEqual(identity('LAB'), identity('LA'))
        self.snapshot['active_applications'] = [self.row(name='真健康 - B',status='A')]
        self.snapshot['listings'] = [{**self.row(name='真健康 - B - H 股'), 'hk_code':'02697',
            'listing_date':'2026-06-30','original_document_url':'https://www1.hkexnews.hk/test.pdf'}]
        result = self.build()
        self.assertEqual(result['rows'], [])
        self.assertEqual(result['resolved'][0]['active_application_ids'], ['1'])
        self.assertEqual(result['resolved'][0]['listing_evidence']['hk_code'], '02697')

    def test_current_fields_do_not_use_newer_inactive_attempt(self):
        self.snapshot['active_applications'] = [self.row(status='A',day='2026-07-01',app_id='1')]
        self.snapshot['application_history'] = [self.row(status='LP',day='2026-08-01',app_id='2')]
        row = self.build()['rows'][0]
        self.assertEqual(row['application_id'], '1')
        self.assertEqual(row['official_status'], 'A')
        self.assertEqual(row['attempt_count'], 2)

    def test_new_terminal_attempt_supersedes_old_lapse(self):
        for status in ["RJ", "LT"]:
            self.snapshot["application_history"] = [self.row(), self.row(status=status, day="2026-08-01", app_id="2")]
            self.assertEqual(self.build()["rows"], [])

    def test_denial_is_not_confidential_confirmation(self):
        self.registry["companies"] = [self.company(self.event(kind="denied"))]
        self.assertEqual(self.build()["rows"], [])

    def test_terminal_issuer_evidence_overrides_stale_active_index_without_deleting_it(self):
        self.snapshot['active_applications'] = [self.row(status='A', day='2026-07-29', app_id='108773')]
        self.registry['companies'] = [self.company(self.event(kind='terminated', day='2026-09-09'))]
        result = self.build()
        self.assertEqual(result['rows'], [])
        self.assertEqual(result['resolved'][0]['active_application_ids'], ['108773'])
        self.assertEqual(self.snapshot['active_applications'][0]['status_code'], 'A')

    def test_active_company_keeps_all_current_ids(self):
        self.snapshot['active_applications'] = [self.row(status='A', app_id='1'), self.row(status='A', app_id='2')]
        result = self.build()
        self.assertEqual(len(result['rows']), 1)
        self.assertEqual(result['rows'][0]['active_application_ids'], ['1','2'])

    def test_media_never_becomes_official_confirmation(self):
        self.registry["companies"] = [self.company(self.event(kind="confidential_reported", level="media"))]
        row = self.build()["rows"][0]
        self.assertEqual(row["status"], "confidential_reported")
        self.assertIsNone(row["last_application_date"])
        self.assertFalse(row["is_a_to_h"])
        self.registry["companies"][0]["events"][0]["kind"] = "confidential_confirmed"
        with self.assertRaises(AssertionError):
            self.build()

    def test_false_a_share_code_rejected(self):
        self.registry["companies"] = [self.company(self.event(kind="confidential_reported", level="media"))]
        self.registry["companies"][0]["a_code"] = "300014"
        with self.assertRaises(AssertionError):
            self.build()

    def test_public_application_supersedes_old_secret_report_even_if_lapsed(self):
        self.snapshot["application_history"] = [self.row(day="2026-02-01")]
        self.registry["companies"] = [self.company(self.event(kind="confidential_reported", level="media", day="2025-12-01"))]
        self.assertEqual(self.build()["rows"][0]["status"], "lapsed_unverified")

    def test_old_evidence_flagged_not_re_dated(self):
        self.registry["companies"] = [self.company(self.event(kind="confidential_reported", level="media", day="2025-06-01"))]
        row = self.build()["rows"][0]
        self.assertTrue(row["needs_review"])
        self.assertEqual(row["bucket"], "confidential")
        self.assertEqual(row["evidence_date"], "2025-06-01")

    def test_company_dedupes_old_applications(self):
        self.snapshot["application_history"] = [self.row(), self.row(day="2025-06-30", app_id="2")]
        rows = self.build()["rows"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["attempt_count"], 2)

    def test_normalization_and_calendar_months(self):
        self.assertEqual(identity("甲有限公司 (前称为乙有限公司)"), identity("甲有限公司"))
        self.assertEqual(six_months("2025-08-31"), "2026-02-28")

    def test_reviewed_truncated_alias_cannot_duplicate_active_company(self):
        self.snapshot["application_history"] = [self.row(name="测试股份有限公")]
        self.snapshot["active_applications"] = [self.row(status="A", day="2026-09-01", app_id="2")]
        self.registry["reviewed_name_aliases"] = [{"alias": "测试股份有限公", "company_name": "测试股份有限公司", "reviewed_at": "2026-09-23", "reason": "verified", "evidence_url": "https://example.com/source"}]
        rows = self.build()["rows"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["status"], rows[0]["attempt_count"]), ("public_active", 2))

    def test_rolling_anniversary_inclusive_and_stale_archive(self):
        self.snapshot["application_history"] = [self.row(day="2025-09-23")]
        self.assertEqual(self.build()["rows"][0]["bucket"], "public")
        self.snapshot["application_history"] = [self.row(day="2025-09-22")]
        self.assertEqual(self.build()["rows"], [])
        self.assertIn("12个月", self.build()["resolved"][0]["reason"])
        self.assertEqual(months_before("2024-02-29", 12), "2023-02-28")

    def test_refile_keeps_company_once_and_updates_status(self):
        self.snapshot["application_history"] = [self.row()]
        self.snapshot["active_applications"] = [self.row(status="A", day="2026-09-01", app_id="2")]
        rows = self.build()["rows"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["status"], rows[0]["attempt_count"]), ("public_active", 2))

    def test_historical_2023_filing_updated_within_year_is_retained(self):
        row = self.row(day="2023-04-01")
        row["documents"] = [{"date": "2023-04-01", "document_type": "申請版本（第一次呈交）"}, {"date": "2025-12-30", "document_type": "申請版本（修訂版）"}]
        self.snapshot["application_history"] = [row]
        self.assertEqual(self.build()["rows"][0]["last_prospectus_update_date"], "2025-12-30")
        self.assertEqual(self.build()["rows"][0]["first_application_date"], "2023-04-01")
        row["documents"][1]["document_type"] = "整体协调人公告"
        self.assertEqual(self.build()["rows"], [])
        row["documents"][1]["document_type"] = "聆訊後資料集（第一次修訂版）"
        self.assertEqual(self.build()["rows"][0]["last_prospectus_update_date"], "2025-12-30")
        self.assertEqual(self.build()["rows"][0]["last_application_date"], "2023-04-01")

    def test_new_progress_article_does_not_reset_prospectus_clock(self):
        self.snapshot["application_history"] = [self.row(day="2025-09-01")]
        self.registry["companies"] = [self.company(self.event(day="2026-09-10"))]
        self.assertEqual(self.build()["rows"], [])

    def test_confidential_tiers_require_explicit_provenance(self):
        event = self.event(kind="confidential_reported", level="media")
        self.registry["companies"] = [self.company(event)]
        self.assertEqual(self.build()["rows"][0]["confidential_tier"], "tier2")
        event["source_tier"] = "authoritative"
        self.assertEqual(self.build()["rows"][0]["confidential_tier"], "tier1")
        event["kind"] = "confidential_planned"
        self.assertEqual(self.build()["rows"][0]["confidential_tier"], "tier2")

    def test_later_market_story_does_not_downgrade_primary_source(self):
        company = self.company(self.event(kind="confidential_confirmed"))
        company["events"].append(self.event(kind="confidential_rumor", level="media", day="2026-09-01"))
        self.registry["companies"] = [company]
        row = self.build()["rows"][0]
        self.assertEqual((row["status"], row["confidential_tier"]), ("confidential_confirmed", "tier1"))
        self.assertEqual(row["classification_source"]["date"], "2026-07-04")

    def test_withdrawal_and_return_are_not_assumed_termination(self):
        for status in ["W", "RT"]:
            self.snapshot["application_history"] = [self.row(status=status)]
            self.assertEqual(len(self.build()["rows"]), 1)

    def test_continuing_news_does_not_erase_existing_confidential_evidence(self):
        company = self.company(self.event(kind="confidential_confirmed"))
        company["events"].append(self.event(kind="continuing", day="2026-09-01"))
        self.registry["companies"] = [company]
        row = self.build()["rows"][0]
        self.assertEqual(row["status"], "confidential_confirmed")
        self.assertEqual(row["classification_source"]["date"], "2026-07-04")

    def test_reliable_media_continuation_is_labeled_reported(self):
        self.snapshot["application_history"] = [self.row()]
        self.registry["companies"] = [self.company(self.event(level="media"))]
        self.assertEqual(self.build()["rows"][0]["status"], "lapsed_reported_continuing")

    def test_exchange_disclosed_previous_name_dedupes(self):
        self.snapshot["application_history"] = [self.row(name="旧公司有限公司")]
        self.snapshot["active_applications"] = [self.row(name="新公司有限公司（前称为旧公司有限公司）", status="A", day="2026-09-01", app_id="2")]
        rows = self.build()["rows"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["attempt_count"], 2)

    def test_real_examples_and_reproducible_output(self):
        root = Path(__file__).resolve().parents[1]
        read = lambda p: json.loads((root / p).read_text(encoding="utf-8"))
        actual = read("public/data/pipeline_watch.json")
        eve = next(r for r in actual["rows"] if r["id"] == "eve-energy")
        kimi = next(r for r in actual["rows"] if r["id"] == "moonshot-ai")
        self.assertEqual((eve["a_code"], eve["status"], eve["first_application_date"], eve["last_application_date"]), ("300014", "lapsed_continuing", "2025-06-30", "2026-01-02"))
        self.assertFalse(kimi["is_a_to_h"])
        self.assertFalse(any(r["id"] == "huaheng-biotech" for r in actual["rows"]))
        self.assertTrue(any(r["id"] == "huaheng-biotech" for r in actual["resolved"]))
        for company_id in ["unigroup", "enn-natural-gas", "lakala", "wondershare", "broad-ocean", "linglong-tire"]:
            self.assertFalse(any(r["id"] == company_id for r in actual["rows"]))
            self.assertTrue(any(r["id"] == company_id for r in actual["resolved"]))
        anji = next(r for r in actual["rows"] if r["id"] == "anji-micro")
        self.assertEqual((anji["a_code"], anji["status"]), ("688019", "confidential_confirmed"))
        # Local official universe is intentionally not part of the public source repository.
        if (root / "data/processed/a_share_official_universe.json").exists():
            expected = build_watch(read("data/processed/full_snapshot.json"), read("data/processed/a_share_official_universe.json"), read("data/reference/pipeline_intelligence.json"), actual["generated_as_of"])
            self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
