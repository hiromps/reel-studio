"""Offline control-plane tests. No Modal calls, GPU starts or paid resources."""
import copy
import unittest
import tempfile
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from modal_backend import app as backend
from modal_backend.contracts import OVERHEAD_USD, disk_usage_bytes, month_key, reservation_usd


class AsyncMethod:
    def __init__(self, fn):
        self.fn = fn

    async def aio(self, *args, **kwargs):
        return self.fn(*args, **kwargs)


class FakeState:
    def __init__(self):
        self.data = {}
        self.get = AsyncMethod(lambda key, default=None: copy.deepcopy(self.data.get(key, default)))
        self.put = AsyncMethod(self.write)
        self.pop = AsyncMethod(lambda key, default=None: self.data.pop(key, default))

    def write(self, key, value, skip_if_exists=False):
        if skip_if_exists and key in self.data:
            return False
        self.data[key] = copy.deepcopy(value)
        return True


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.state = FakeState()
        self.calls = []
        self.cancelled = []
        self.results = {}

        def spawn(job_id, body):
            self.calls.append((job_id, body))
            return SimpleNamespace(object_id="fc-" + job_id)

        def from_id(call_id):
            def get(timeout=0):
                result = self.results.get(call_id, TimeoutError())
                if isinstance(result, BaseException):
                    raise result
                return result
            return SimpleNamespace(get=AsyncMethod(get), cancel=AsyncMethod(lambda **kwargs: self.cancelled.append(call_id)))

        self.patches = [patch.object(backend, "state", self.state),
                        patch.object(backend, "gpu_job", SimpleNamespace(spawn=AsyncMethod(spawn))),
                        patch.object(backend.modal.FunctionCall, "from_id", from_id)]
        for p in self.patches:
            p.start()
        self.client = TestClient(backend.api.local())

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()

    def submit(self, **patches):
        body = {"kind": "gpu-test", "allowGpu": True, "requestId": str(uuid4()), "maxSeconds": 30}
        body.update(patches)
        return self.client.post("/jobs", json=body)

    def test_read_only_routes_never_start_gpu(self):
        self.assertEqual(self.client.get("/health").status_code, 200)
        self.assertEqual(self.client.get("/gpu/info").json()["gpuStarted"], False)
        self.assertEqual(self.calls, [])

    def test_missing_explicit_permission_and_bad_images_are_rejected(self):
        self.assertEqual(self.submit(allowGpu=False).status_code, 422)
        self.assertEqual(self.submit(kind="text-to-image").status_code, 422)
        self.assertEqual(self.submit(kind="image-to-image", prompt="food", imageBase64="bad").status_code, 422)
        self.assertEqual(self.submit(kind="image-to-image", prompt="food", imageBase64="bm90IGFuIGltYWdl").status_code, 422)
        self.assertEqual(self.submit(maxSeconds=601).status_code, 422)
        self.assertEqual(self.submit(arbitrary_code="print(1)").status_code, 422)
        self.assertEqual(self.calls, [])

    def test_budget_blocks_before_spawn(self):
        self.assertEqual(self.submit(budgetUsd=0.1).status_code, 429)
        self.assertEqual(self.calls, [])
        self.assertGreater(reservation_usd(300), 300 * 0.000842)
        self.assertGreater(OVERHEAD_USD, 0)

    def test_idempotency_and_no_parallel_gpu_jobs(self):
        request_id = str(uuid4())
        first = self.submit(requestId=request_id)
        self.assertEqual(first.status_code, 202)
        self.assertEqual(self.submit(requestId=request_id).json()["id"], request_id)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.submit().status_code, 409)
        self.assertEqual(self.submit(requestId=request_id, maxSeconds=31).status_code, 409)

    def test_cancel_keeps_slot_until_control_plane_confirms(self):
        job = self.submit().json()
        self.assertEqual(self.client.post(f"/jobs/{job['id']}/cancel").json()["status"], "cancelling")
        self.assertEqual(len(self.cancelled), 1)
        self.assertEqual(self.submit().status_code, 409)
        self.results["fc-" + job["id"]] = backend.modal.exception.InputCancellation("cancelled")
        self.assertEqual(self.client.get(f"/jobs/{job['id']}").json()["status"], "cancelled")
        self.assertEqual(self.submit().status_code, 202)

    def test_finished_failed_and_timeout_jobs_keep_full_reservation(self):
        job = self.submit().json()
        self.results["fc-" + job["id"]] = {"error": "JOB_TIMEOUT"}
        dashboard = self.client.get("/health").json()
        self.assertEqual(dashboard["jobs"][0]["status"], "failed")
        self.assertEqual(dashboard["usage"]["committedUsd"], job["estimatedCostUsd"])
        self.assertIsNone(dashboard["usage"]["activeJobId"])

    def test_transient_errors_do_not_release_slot(self):
        job = self.submit().json()
        self.results["fc-" + job["id"]] = ConnectionError("offline")
        self.assertEqual(self.submit().status_code, 409)

    def test_crash_between_reservation_and_spawn_fails_closed(self):
        job = self.submit().json()
        del self.state.data["ledger"]["jobs"][job["id"]]["callId"]
        self.assertEqual(self.submit().status_code, 409)

    def test_monthly_rollover_preserves_an_old_active_job(self):
        self.submit()
        with patch.object(backend, "month_key", lambda: "2099-01"):
            v = self.client.get("/health").json()
            self.assertGreater(v["usage"]["committedUsd"], 0)
            self.assertIsNotNone(v["usage"]["activeJobId"])
            self.assertEqual(self.submit().status_code, 409)

    def test_job_metadata_never_returns_call_ids_or_fingerprints(self):
        self.submit()
        data = self.client.get("/health").text
        self.assertNotIn("callId", data)
        self.assertNotIn("fingerprint", data)
        self.assertEqual(self.client.get("/jobs/../../etc/passwd").status_code, 404)

    def test_persistent_control_lock_blocks_overlap_after_container_crash(self):
        self.state.data["control-lock"] = {"createdAt": "2026-11-01"}
        self.assertEqual(self.submit().status_code, 503)
        self.assertEqual(self.calls, [])

    def test_model_cache_links_are_not_counted_twice(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            blob = root / "blob"
            blob.write_bytes(b"weights")
            os.link(blob, root / "hardlink")
            self.assertEqual(disk_usage_bytes(root), len(b"weights"))


if __name__ == "__main__":
    unittest.main()
