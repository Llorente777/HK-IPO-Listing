import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from scripts.hkex_pipeline import Fetcher


class FetchDiagnostics(unittest.TestCase):
    def test_failure_records_actual_url_and_each_attempt_separately(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'attempt'
            fetcher = Fetcher(path)
            with patch('scripts.hkex_pipeline.urllib.request.urlopen', side_effect=OSError('TLS EOF')), \
                 patch('scripts.hkex_pipeline.time.sleep'):
                with self.assertRaisesRegex(RuntimeError, 'after 2 attempts: https://example.com/official'):
                    fetcher.get('https://example.com/official', retries=2)
            rows = [json.loads(line) for line in (path / 'requests.jsonl').read_text().splitlines()]
            self.assertEqual([r['attempt'] for r in rows], [1, 2])
            self.assertTrue(all(r['status'] == 'failed' and r['observed_at'] for r in rows))
            self.assertEqual(fetcher.manifest, [])

    def test_success_is_recorded_without_request_headers(self):
        with tempfile.TemporaryDirectory() as tmp:
            fetcher = Fetcher(Path(tmp) / 'attempt')
            response = MagicMock()
            response.__enter__.return_value = response
            response.read.return_value = b'official'
            response.status = 200
            with patch('scripts.hkex_pipeline.urllib.request.urlopen', return_value=response):
                self.assertEqual(fetcher.get('https://example.com/official'), b'official')
            row = json.loads((fetcher.diagnostic_dir / 'requests.jsonl').read_text())
            self.assertEqual(row['status'], 'downloaded')
            self.assertEqual(row['bytes'], 8)
            self.assertNotIn('headers', row)

    def test_diagnostic_directory_is_never_reused(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileExistsError):
                Fetcher(Path(tmp))
