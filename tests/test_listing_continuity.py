import hashlib
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from scripts.hkex_pipeline import fill_verified_nlr_gaps, HKEX_NEWLY_LISTED_SECURITIES


def table(*entries):
    return (''.join('<tr>'+''.join(f'<td>{x}</td>' for x in [day, code, code, '100', '#', '', 'S', '%', 'New Listing', ''])+'</tr>'
                    for day, code in entries)+'Updated 25 Sep 2026').encode()


class Stub:
    def __init__(self, payload): self.payload = payload
    def save(self, url, path, **kwargs):
        return b'%PDF'+b'x'*10001 if path.endswith('.pdf') else self.payload


class ListingContinuity(unittest.TestCase):
    def parent(self, folder, through='2026-09-21', day='2026-09-22'):
        data = {'snapshot_date':day, 'quality':{'source_freshness':{
            'hkex_new_listing_report_as_of':'2026-09-09', 'hkex_newly_listed_securities_as_of':through,
            'verified_post_nlr_listing_codes':['06727']}},
            'sources':[{'url':HKEX_NEWLY_LISTED_SECURITIES,'sha256':'original-official-source-hash'},
                       {'url':'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0918/2026091801414.pdf',
                        'local_file':'data/raw/official/hkex/final-allotments/06727-2026-09-21.pdf',
                        'sha256':hashlib.sha256(b'%PDF'+b'x'*10001).hexdigest()}],
            'listings':[{'hk_code':'06727','listing_date':'2026-09-21','year':2026,'sequence':110,
                         'source_url':'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0918/2026091801414.pdf'}]}
        payload=json.dumps(data).encode()
        (folder/'latest.json').write_bytes(payload)
        (folder/f'{day}--stamp--{hashlib.sha256(payload).hexdigest()[:12]}.json').write_bytes(payload)

    def run_fill(self, directory=None, payload=None):
        f=Stub(payload or table(('15/09/2026','10001'),('21/09/2026','06727'),('22/09/2026','09856')))
        rows=[]
        result=fill_verified_nlr_gaps(f,rows,{'applisted_sehk_c':[{'hk_code':'06727'},{'hk_code':'09856'}]},date(2026,9,28),'2026-09-09',directory)
        return rows,result,f.listing_continuity

    def test_no_evidence_does_not_bypass_gap(self):
        with self.assertRaisesRegex(ValueError,'uncovered interval'): self.run_fill()

    def test_verified_parent_bridges_and_non_h_share_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp); self.parent(folder)
            rows,result,proof=self.run_fill(folder)
            self.assertEqual(result,('2026-09-25',['06727','09856']))
            self.assertFalse(rows[-1]['is_h_share_name'])
            self.assertEqual(rows[-1]['total_proceeds_hkd'],5669604512)
            self.assertEqual(proof['parent_coverage_through'],'2026-09-21')
            self.assertEqual(len(proof['parent_sha256']),64)

    def test_non_overlapping_parent_still_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp); self.parent(folder,through='2026-09-13')
            with self.assertRaisesRegex(ValueError,'overlap'): self.run_fill(folder)

    def test_modified_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp); self.parent(folder)
            with (folder/'latest.json').open('ab') as handle: handle.write(b' ')
            with self.assertRaisesRegex(ValueError,'immutable archive'): self.run_fill(folder)

    def test_future_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp); self.parent(folder,day='2026-10-01')
            with self.assertRaisesRegex(ValueError,'future'): self.run_fill(folder)

    def test_current_and_retained_evidence_must_agree(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp); self.parent(folder)
            with self.assertRaisesRegex(ValueError,'conflict'): self.run_fill(folder,table(('15/09/2026','10001'),('20/09/2026','06727')))

    def test_listing_aged_out_of_rolling_page_is_not_lost(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp); self.parent(folder,through='2026-09-25',day='2026-09-25')
            rows,_,proof=self.run_fill(folder,table(('22/09/2026','09856')))
            self.assertEqual({r['hk_code'] for r in rows},{'06727','09856'})
            self.assertEqual(proof['carried_listing_codes'],['06727'])

    def test_new_nlr_absorbs_old_gap_without_false_block(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp); self.parent(folder,through='2026-09-25',day='2026-09-25')
            rows=[{'hk_code':'06727','listing_date':'2026-09-21'}]
            f=Stub(table(('23/09/2026','10001')))
            result=fill_verified_nlr_gaps(f,rows,{},date(2026,9,28),'2026-09-21',folder)
            self.assertEqual(result,('2026-09-25',[]))
            self.assertEqual(f.listing_continuity['carried_listing_codes'],[])
            self.assertEqual(len(rows),1)

    def test_absorbed_listing_missing_from_new_nlr_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp); self.parent(folder,through='2026-09-25',day='2026-09-25')
            for rows in ([],[{'hk_code':'06727','listing_date':'2026-09-20'}]):
                with self.assertRaisesRegex(ValueError,'absorbed'):
                    fill_verified_nlr_gaps(Stub(table(('23/09/2026','10001'))),rows,{},date(2026,9,28),'2026-09-21',folder)

    def test_new_nlr_regression_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp); self.parent(folder,through='2026-09-25',day='2026-09-25')
            with self.assertRaisesRegex(ValueError,'regressed'):
                fill_verified_nlr_gaps(Stub(table(('23/09/2026','10001'))),[],{},date(2026,9,28),'2026-09-08',folder)

    def test_partial_absorption_preserves_only_remaining_verified_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp); self.parent(folder,through='2026-09-25',day='2026-09-25')
            parent=json.loads((folder/'latest.json').read_text())
            remaining={**parent['listings'][0],'hk_code':'09856','listing_date':'2026-09-22'}
            parent['listings'].append(remaining)
            parent['quality']['source_freshness']['verified_post_nlr_listing_codes'].append('09856')
            def save():
                payload=json.dumps(parent).encode()
                (folder/'latest.json').write_bytes(payload)
                (folder/f'2026-09-25--new--{hashlib.sha256(payload).hexdigest()[:12]}.json').write_bytes(payload)
            save()
            rows=[{'hk_code':'06727','listing_date':'2026-09-21'}]
            f=Stub(table(('23/09/2026','10001')))
            result=fill_verified_nlr_gaps(f,rows,{},date(2026,9,28),'2026-09-21',folder)
            self.assertEqual(result,('2026-09-25',['09856']))
            self.assertEqual({r['hk_code'] for r in rows},{'06727','09856'})
            parent['quality']['source_freshness']['verified_post_nlr_listing_codes']=[]
            save()
            with self.assertRaisesRegex(ValueError,'registry'):
                fill_verified_nlr_gaps(f,rows,{},date(2026,9,28),'2026-09-21',folder)


if __name__ == '__main__': unittest.main()
