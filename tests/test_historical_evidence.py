import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pipeline_analytics import historical_evidence


class HistoricalEvidenceTests(unittest.TestCase):
    def test_same_day_immutable_evidence_survives_empty_later_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp)
            row={'application_id':'1','company_name':'测试 - B','sponsors':['已核实机构'],
                 'sponsor_source_url':'https://www1.hkexnews.hk/source.pdf',
                 'documents':[{'full_document_url':'https://www1.hkexnews.hk/ap.pdf','date':'2026-09-20','document_type':'AP'}]}
            def save(name,r):
                (directory/name).write_text(json.dumps({'snapshot_date':name[:10],'active_applications':[r]}),encoding='utf-8')
            save('2026-09-20--1--abc.json',row)
            save('2026-09-20--2--def.json',{**row,'sponsors':[],'documents':[]})
            save('2026-09-21.json',{**row,'sponsors':['未来资料']})
            result=historical_evidence(directory,'2026-09-20')['1']
            self.assertEqual(result['sponsors'],['已核实机构'])
            self.assertEqual(len(result['documents']),1)

    def test_conflicting_company_identity_blocks_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp)
            for day,name in [('20','甲公司'),('21','乙公司')]:
                (directory/f'2026-09-{day}.json').write_text(json.dumps({'snapshot_date':f'2026-09-{day}',
                    'active_applications':[{'application_id':'1','company_name':name}]}),encoding='utf-8')
            with self.assertRaisesRegex(ValueError,'conflict'):
                historical_evidence(directory,'2026-09-22')
