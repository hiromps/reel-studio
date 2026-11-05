import base64
import hashlib
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
from modal_backend import app as backend, media
from modal_backend.test_api import ApiTests, AsyncMethod


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.storage_patch = patch.object(backend, 'storage', SimpleNamespace(reload=AsyncMethod(lambda: None), commit=AsyncMethod(lambda: None)))
        self.root_patch = patch.object(media, 'ROOT', Path(self.temp.name))
        self.storage_patch.start(); self.root_patch.start()
        ApiTests.setUp(self)

    def tearDown(self):
        ApiTests.tearDown(self)
        self.storage_patch.stop(); self.root_patch.stop(); self.temp.cleanup()

    def upload(self, session_id=None, path='uploads/sample.mp4', reuse=None):
        ident, file_id, raw = session_id or str(uuid4()), str(uuid4()), b'fake-private-video'
        manifest = {'id': ident, 'allowUpload': True, 'files': [{'id': file_id, 'path': path, 'size': len(raw)}]}
        if reuse: manifest['reuseSessionId'] = reuse
        r = self.client.post('/render/sessions', json=manifest)
        self.assertEqual(r.status_code, 200, r.text)
        chunk = {'data': base64.b64encode(raw).decode(), 'sha256': hashlib.sha256(raw).hexdigest()}
        route = f'/render/sessions/{ident}/files/{file_id}'
        self.assertEqual(self.client.post(route + '/chunks/0', json=chunk).status_code, 200)
        self.assertEqual(self.client.post(route + '/chunks/0', json=chunk).status_code, 200)
        self.assertEqual(self.client.post(route + '/complete').status_code, 200)
        return ident, file_id, raw

    def test_upload_and_private_range_never_start_gpu(self):
        ident, file_id, raw = self.upload()
        r = self.client.get(f'/render/sessions/{ident}/assets/uploads/sample.mp4', headers={'Range': 'bytes=2-6'})
        self.assertEqual(r.status_code, 206)
        self.assertEqual(r.content, raw[2:7])
        self.assertEqual(r.headers['content-range'], f'bytes 2-6/{len(raw)}')
        self.assertEqual(r.headers['cache-control'], 'private, no-store')
        self.assertEqual(self.calls, [])
        self.assertEqual(self.client.post(f'/render/sessions/{ident}/files/{file_id}/chunks/0', json={'data': 'YWJj', 'sha256': hashlib.sha256(b'abc').hexdigest()}).status_code, 409)

    def test_append_reuses_immutable_assets(self):
        ident, _, raw = self.upload()
        other, _, _ = self.upload(path='uploads/second.mp4', reuse=ident)
        self.assertEqual(self.client.get(f'/render/sessions/{other}/assets/uploads/sample.mp4').content, raw)
        self.assertEqual(len(self.client.get(f'/render/sessions/{other}').json()['files']), 2)
        self.assertEqual(self.calls, [])

    def test_missing_media_budget_and_invalid_inputs_rejected_before_spawn(self):
        ident, _, _ = self.upload()
        body = {'kind': 'remotion-render', 'sessionId': ident, 'allowGpu': True, 'requestId': str(uuid4()), 'maxSeconds': 30, 'cuts': {'fps': 30, 'cuts': [{'src': 'uploads/missing.mp4', 'inSec': 0, 'outSec': 1}]}}
        self.assertEqual(self.client.post('/jobs', json=body).status_code, 409)
        body['cuts']['cuts'][0]['src'] = 'https://private.example/video.mp4'
        self.assertEqual(self.client.post('/jobs', json=body).status_code, 422)
        body['cuts']['cuts'][0]['src'] = 'uploads/sample.mp4'
        body['cuts']['cuts'][0]['outSec'] = 181
        self.assertEqual(self.client.post('/jobs', json=body).status_code, 422)
        body['cuts']['cuts'][0]['outSec'] = 1
        body['budgetUsd'] = 0
        self.assertEqual(self.client.post('/jobs', json=body).status_code, 429)
        self.assertEqual(self.calls, [])

    def test_active_render_protects_input_from_deletion(self):
        ident, _, _ = self.upload()
        body = {'kind': 'remotion-render', 'sessionId': ident, 'allowGpu': True, 'requestId': str(uuid4()), 'maxSeconds': 30, 'cuts': {'fps': 30, 'cuts': [{'src': 'uploads/sample.mp4', 'inSec': 0, 'outSec': 1}]}}
        self.assertEqual(self.client.post('/jobs', json=body).status_code, 202)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.client.delete('/render/sessions/' + ident).status_code, 409)

    def test_bad_manifest_and_chunk_integrity(self):
        for path in ['uploads/../key.mp4', 'uploads/x$(whoami).mp4', 'fonts/run.py', 'https://example.com/file.mp4']:
            r = self.client.post('/render/sessions', json={'id': str(uuid4()), 'allowUpload': True, 'files': [{'id': str(uuid4()), 'path': path, 'size': 1}]})
            self.assertEqual(r.status_code, 422)
        self.assertEqual(self.calls, [])


if __name__ == '__main__': unittest.main()
