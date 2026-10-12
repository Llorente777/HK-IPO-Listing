import unittest
from datetime import date

from scripts.hkex_pipeline import (
    calendar_week_activity, fill_verified_nlr_gaps, listing_direction,
    name_cross_check, parse_newly_listed_securities,
    split_ipo_and_non_ipo_listings, sponsor_listed_summary, retain_prior_application_history,
)


class PipelineRules(unittest.TestCase):
    def test_missing_index_id_retains_filing_evidence_without_claiming_current_status(self):
        old = {'application_id':'108395','company_name':'XREAL Ltd.','latest_document_date':'2026-04-01',
               'status_code':'A','status':'处理中','documents':[{'date':'2026-04-01','document_type':'AP'}]}
        previous={'snapshot_date':'2026-09-29','application_history':[old], 'active_applications':[old]}
        result=retain_prior_application_history([],[],previous,'2026-10-07')
        self.assertEqual(len(result),1)
        self.assertEqual(result[0]['status_code'],'U')
        self.assertEqual(result[0]['documents'],old['documents'])
        self.assertEqual(result[0]['history_retained_source_date'],'2026-09-29')
        self.assertEqual(old['status_code'],'A')
        fresh={**old,'status_code':'LP'}
        self.assertEqual(retain_prior_application_history([fresh],[],previous,'2026-10-07'),[fresh])
        self.assertEqual(retain_prior_application_history([],[],{**previous,'snapshot_date':'2026-10-08'},'2026-10-07'),[])

    def test_live_listing_reconciliation_excludes_tentative_and_etf(self):
        def row(day, name, code, stamp):
            cells = [day, name, code, "100", "#", "", stamp, "%", "New Listing", ""]
            return "<tr>" + "".join(f"<td>{cell}</td>" for cell in cells) + "</tr>"

        html = (
            row("09/09/2026", "EXCELLAND ROBOT", "03231", "S")
            + row("15/09/2026", "GXCOPPERMINER", "03014", "")
            + row("21/09/2026", "TRANSWARP", "06727", "S")
            + row("22/09/2026*", "LIGENT", "09856", "S")
            + "Updated 21 Sep 2026"
        ).encode()
        rows, updated = parse_newly_listed_securities(html)
        self.assertEqual(updated, "2026-09-21")
        self.assertTrue(next(item for item in rows if item["hk_code"] == "09856")["tentative"])

        class FetcherStub:
            def save(self, url, path, **kwargs):
                return b"%PDF" + b"x" * 10_000 if path.endswith(".pdf") else html

        listings = [{"year": 2026, "sequence": 109, "hk_code": "03231"}]
        as_of, added = fill_verified_nlr_gaps(
            FetcherStub(), listings,
            {"applisted_sehk_c": [{"hk_code": "06727"}]},
            date(2026, 9, 22), "2026-09-09",
        )
        self.assertEqual((as_of, added), ("2026-09-21", ["06727"]))
        self.assertEqual(listings[-1]["total_proceeds_hkd"], 686_529_200)

    def test_transfers_and_introductions_not_ipo(self):
        rows = [
            {"hk_code": "03774", "market": "主板", "total_proceeds_hkd": 0},
            {"hk_code": "06051", "market": "主板", "total_proceeds_hkd": 0},
            {"hk_code": "06655", "market": "主板", "total_proceeds_hkd": 0,
             "original_document_title": "以介紹方式上市"},
            {"hk_code": "02665", "market": "主板", "total_proceeds_hkd": 0},
        ]
        ipos, excluded = split_ipo_and_non_ipo_listings(rows)
        self.assertEqual(ipos, [])
        self.assertEqual([row["ipo_classification"] for row in excluded],
                         ["GEM转主板", "GEM转主板", "介绍上市", "De-SPAC继承公司"])

    def test_reused_code_is_not_permanent_exclusion(self):
        ipos, excluded = split_ipo_and_non_ipo_listings([
            {"hk_code": "03774", "market": "主板", "total_proceeds_hkd": 100_000_000}])
        self.assertEqual(len(ipos), 1)
        self.assertEqual(excluded, [])

    def test_identity_checks_both_sides_not_itself(self):
        self.assertEqual(name_cross_check("甲科技股份有限公司", "乙食品股份有限公司"), "代码一致，名称需人工复核")
        self.assertEqual(name_cross_check("甲科技股份有限公司 - B", "甲科技股份有限公司"), "代码与公司名双重一致")
        self.assertEqual(name_cross_check("福建万辰食品集团股份有限公司 (前称为福建万辰生物科技集团股份有限公司)", "福建万辰食品集团股份有限公司"), "代码与公司名双重一致")

    def test_listing_direction(self):
        self.assertEqual(listing_direction("2025-12-10", "2022-09-01"), "H→A")
        self.assertEqual(listing_direction("2001-01-01", "2022-09-01"), "A→H")
        self.assertEqual(listing_direction(None, "2022-09-01"), "上市先后待核验")
        self.assertEqual(listing_direction("2022-09-01", "2022-09-01"), "同期上市")

    def test_sum_before_rounding(self):
        rows = [{"hk_code": str(i), "company_name": str(i), "year": 2026,
                 "sponsors": ["甲"], "total_proceeds_hkd": 6_000_000} for i in range(3)]
        summary = sponsor_listed_summary(rows, 2026)[0]
        self.assertEqual(summary["current_year_attributed_proceeds_hkd"], 18_000_000)
        self.assertEqual(summary["current_year_attributed_proceeds_hkd_bn"], 0.02)

    def test_week_uses_ap_dates_and_deduplicates_history(self):
        row = {"application_id": "1", "company_name": "甲公司", "documents": [
            {"date": "2026-08-26", "document_type": "申請版本"},
            {"date": "2026-08-27", "document_type": "聆訊後資料集"},
            {"date": "2026-08-31", "document_type": "申請版本"},
        ]}
        result = calendar_week_activity({"snapshot_date": "2026-09-02", "listings": [],
            "application_history": [row], "active_applications": [row]}, "2026-08-25")
        self.assertEqual((result["period_start"], result["period_end"]), ("2026-08-24", "2026-08-30"))
        self.assertEqual(len(result["applications"]), 1)
        self.assertEqual(result["application_company_count"], 1)
        self.assertFalse(result["listing_coverage_complete"])


if __name__ == "__main__":
    unittest.main()
