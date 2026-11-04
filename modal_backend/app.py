"""Deploy with python -m modal deploy -m modal_backend.app.

The CPU API owns admission/budgets. One GPU function handles ALL job types.
Neither deployment, /health, nor /gpu/info starts a GPU.
"""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from uuid import UUID

import modal
from modal_backend.contracts import (
    GPU, JobInput, MAX_BUDGET_USD, MAX_RESULT_BYTES, OVERHEAD_USD,
    SCALEDOWN_SECONDS, TERMINAL, month_key, reservation_usd, utc_now,
    disk_usage_bytes,
)

app = modal.App("reel-studio-gpu")
state = modal.Dict.from_name("reel-studio-gpu-state", create_if_missing=True)
storage = modal.Volume.from_name("reel-studio-gpu-data", create_if_missing=True)
cpu_image = (modal.Image.debian_slim(python_version="3.11")
             .pip_install("fastapi==0.116.1", "pydantic==2.11.7", "Pillow==11.3.0")
             .add_local_python_source("modal_backend"))
gpu_image = (modal.Image.debian_slim(python_version="3.11")
             .apt_install("ffmpeg", "libgl1", "libglib2.0-0")
             .pip_install("torch==2.8.0", "torchvision==0.23.0", index_url="https://download.pytorch.org/whl/cu128")
             .pip_install("diffusers==0.35.1", "transformers==4.56.2", "accelerate==1.10.1",
                          "safetensors==0.6.2", "sentencepiece==0.2.1", "Pillow==11.3.0",
                          "imageio==2.37.0", "imageio-ffmpeg==0.6.0", "pydantic==2.11.7", "ftfy==6.3.1")
             .env({"HF_HOME": "/data/models", "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false"})
             .add_local_python_source("modal_backend"))


@app.function(image=gpu_image, gpu=GPU, cpu=(4, 4), memory=(65536, 65536),
              volumes={"/data": storage}, min_containers=0, max_containers=1,
              buffer_containers=0, scaledown_window=SCALEDOWN_SECONDS,
              timeout=650, startup_timeout=180, retries=0, single_use_containers=True)
def gpu_job(job_id: str, payload: dict):
    started = time.monotonic()

    def progress(status, percent, **extra):
        state[f"progress:{job_id}"] = {"status": status, "progress": percent, **extra}

    try:
        progress("loading", 1)
        storage.reload()
        # Single GPU writer; prune old outputs at the next explicitly allowed job.
        outputs = Path("/data/results")
        outputs.mkdir(parents=True, exist_ok=True)
        for old in outputs.glob("*/*"):
            if old.is_file() and old.stat().st_mtime < time.time() - 7 * 86400:
                old.unlink()
        # Separate process gives EVERY task a wall-clock deadline, including
        # model download/loading, CUDA execution, and MP4 encoding.
        with tempfile.TemporaryDirectory() as temp:
            request_file = Path(temp) / "request.json"
            progress_file = Path(temp) / "progress.json"
            result_file = Path(temp) / "result.json"
            request_file.write_text(json.dumps(payload))
            with (Path(temp) / "worker.log").open("w") as log:
                process = subprocess.Popen([sys.executable, "-m", "modal_backend.models",
                    str(request_file), str(progress_file), str(result_file), job_id],
                    stdout=log, stderr=log)
                previous = None
                try:
                    while process.poll() is None:
                        if time.monotonic() - started >= payload["maxSeconds"]:
                            process.kill()
                            process.wait()
                            raise TimeoutError("JOB_TIMEOUT")
                        if disk_usage_bytes(Path('/data')) > 80 * 1024**3:
                            process.kill()
                            process.wait()
                            raise RuntimeError("STORAGE_LIMIT")
                        if progress_file.exists():
                            try:
                                update = json.loads(progress_file.read_text())
                                if update != previous:
                                    progress(**update)
                                    previous = update
                            except (ValueError, OSError):
                                pass
                        time.sleep(1)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
            if process.returncode != 0:
                if result_file.exists():
                    diagnostic = json.loads(result_file.read_text()).get("diagnostic", "Model process failed")
                    print(diagnostic)
                # Logs stay in this private container. No upstream exception
                # text, prompts, filesystem paths, or credentials reach UI.
                raise RuntimeError("MODEL_EXECUTION_FAILED")
            result = json.loads(result_file.read_text())
            if result.get("path"):
                result_path = Path(result["path"])
                if result_path.stat().st_size > MAX_RESULT_BYTES:
                    result_path.unlink()
                    raise RuntimeError("RESULT_TOO_LARGE")
        storage.commit()
        result["runSeconds"] = round(time.monotonic() - started, 2)
        result["completedAt"] = utc_now()
        progress("completed", 100)
        return result
    except Exception as error:
        code = "JOB_TIMEOUT" if isinstance(error, TimeoutError) else str(error) if str(error) in {"STORAGE_LIMIT", "RESULT_TOO_LARGE", "MODEL_EXECUTION_FAILED"} else "GPU_OR_MODEL_ERROR"
        print(f"GPU worker stopped: {code} ({type(error).__name__})")
        progress("failed", 0, error=code)
        return {"error": code}


@app.function(image=cpu_image, cpu=(0.25, 0.25), memory=(512, 512),
              volumes={"/data": storage}, min_containers=0, max_containers=1,
              buffer_containers=0, scaledown_window=2, timeout=60)
@modal.concurrent(max_inputs=32)
@modal.asgi_app(requires_proxy_auth=True)
def api():
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.exceptions import RequestValidationError
    from fastapi.responses import FileResponse, JSONResponse
    from pydantic import ValidationError

    web = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    local_lock = asyncio.Lock()

    @asynccontextmanager
    async def control_lock():
        # Dict's atomic skip_if_exists also protects rolling deployments where
        # an old API container may briefly overlap a new deployment. A crash
        # leaves this locked: fail closed instead of risking duplicate spend.
        async with local_lock:
            acquired = await state.put.aio("control-lock", {"createdAt": utc_now()}, skip_if_exists=True)
            if not acquired:
                raise HTTPException(503, "Control plane busy; reconcile persistent lock if needed")
            try:
                yield
            finally:
                await state.pop.aio("control-lock")

    @web.exception_handler(RequestValidationError)
    async def validation_error(_request, _error):
        return JSONResponse({"detail": "Invalid request"}, status_code=422)

    @web.exception_handler(Exception)
    async def unexpected_error(_request, _error):
        return JSONResponse({"detail": "Provider unavailable"}, status_code=503)

    @web.middleware("http")
    async def limit_body(request: Request, call_next):
        try:
            length = int(request.headers.get("content-length", "0"))
        except ValueError:
            return JSONResponse({"detail": "Invalid length"}, status_code=400)
        if length > 9 * 1024 * 1024:
            return JSONResponse({"detail": "Request too large"}, status_code=413)
        # Do not read the whole request before enforcing a streaming limit.
        if request.method == "POST":
            size = 0
            chunks = []
            async for chunk in request.stream():
                size += len(chunk)
                if size > 9 * 1024 * 1024:
                    return JSONResponse({"detail": "Request too large"}, status_code=413)
                chunks.append(chunk)
            request._body = b"".join(chunks)
        return await call_next(request)

    async def ledger():
        v = await state.get.aio("ledger", None)
        if v is None:
            v = {"jobs": {}, "months": {}, "gpuInfo": None, "recent": []}
        if not isinstance(v.get("jobs"), dict) or not isinstance(v.get("months"), dict):
            raise HTTPException(503, "Ledger unavailable")
        # Refresh by FunctionCall, NOT stale progress flags. Lost/cancelled/
        # timed-out GPU containers cannot leave the budget slot locked forever.
        for j in v["jobs"].values():
            if j["status"] in TERMINAL:
                continue
            call_id = j.get("callId")
            if not call_id:
                # Ambiguous admission (CPU crashed during spawn) stays locked.
                # An operator must reconcile; automatically spawning can double-charge.
                continue
            update = await state.get.aio(f"progress:{j['id']}", {})
            if update.get("status") not in TERMINAL and j["status"] != "cancelling":
                j.update(update)
            try:
                result = await modal.FunctionCall.from_id(call_id).get.aio(timeout=0)
                j["endedAt"] = result.get("completedAt", utc_now())
                if j["status"] == "cancelling":
                    j["status"] = "cancelled"
                elif result.get("error"):
                    j.update(status="failed", error=result["error"])
                else:
                    j.update(status="completed", progress=100)
                    if result.get("gpuInfo"):
                        j["gpuInfo"] = result["gpuInfo"]
                        v["gpuInfo"] = result["gpuInfo"]
                    if result.get("resultType"):
                        j["resultType"] = result["resultType"]
                        j["resultPath"] = result["path"]
                        j["model"] = result.get("model")
            except (modal.exception.FunctionTimeoutError, modal.exception.InputCancellation,
                    modal.exception.RemoteError, modal.exception.DeserializationError,
                    modal.exception.OutputExpiredError):
                j.update(status="cancelled" if j["status"] == "cancelling" else "failed", endedAt=utc_now(), error="CANCELLED_OR_WORKER_STOPPED")
            except TimeoutError:
                pass
            except Exception:
                # A transient control-plane error is NOT proof the GPU stopped.
                # Keep the slot and full reservation until completion is confirmed.
                pass
        # Carry a full reservation into the next UTC month if execution crosses
        # a month boundary. Never forget an old active GPU at the monthly reset.
        month = month_key()
        for j in v["jobs"].values():
            if j["createdAt"][:7] != month and (j["status"] not in TERMINAL or j.get("endedAt", "")[:7] == month):
                v["months"].setdefault(month, {}).setdefault(j["id"], j["estimatedCostUsd"])
        await state.put.aio("ledger", v)
        return v

    def public_job(j):
        return {k: val for k, val in j.items() if k not in {"callId", "resultPath", "fingerprint"}}

    def dashboard(v):
        month = month_key()
        committed = sum(v["months"].get(month, {}).values())
        active = next((j["id"] for j in v["jobs"].values() if j["status"] not in TERMINAL), None)
        return {"ok": True, "gpu": GPU, "config": {"monthlyBudgetUsd": MAX_BUDGET_USD, "maxJobSeconds": 600},
            "usage": {"month": month, "budgetUsd": MAX_BUDGET_USD, "committedUsd": round(committed, 6),
                "overheadReserveUsd": round(OVERHEAD_USD, 2), "remainingUsd": round(max(0, MAX_BUDGET_USD - committed - OVERHEAD_USD), 6),
                "activeJobId": active, "source": "estimate", "billingUrl": "https://modal.com/docs/guide/budgets",
                "note": "保守的な予約額。起動・実行上限・CPU・メモリ・80GiBストレージ・転送・余裕分を含む。実際の請求額とは異なります。他アプリの使用量は含みません。月はUTC暦月。"},
            "jobs": [public_job(j) for j in list(v["jobs"].values())[-100:]][::-1],
            "gpuInfo": v["gpuInfo"], "scaling": {"minContainers": 0, "maxContainers": 1, "scaledownSeconds": SCALEDOWN_SECONDS}}

    @web.get("/health")
    async def health():
        async with control_lock():
            return dashboard(await ledger())

    @web.get("/gpu/info")
    async def cached_gpu_info():
        async with control_lock():
            v = await ledger()
            return {"gpuInfo": v["gpuInfo"], "cached": True, "gpuStarted": False}

    async def parse_job(request):
        try:
            return JobInput.model_validate(await request.json())
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid job")

    @web.post("/estimate")
    async def estimate(request: Request):
        payload = await parse_job(request)
        return {"estimatedCostUsd": reservation_usd(payload.maxSeconds), "overheadReserveUsd": OVERHEAD_USD, "gpuStarted": False}

    @web.post("/jobs", status_code=202)
    async def submit(request: Request):
        payload = await parse_job(request)
        async with control_lock():
            v = await ledger()
            job_id = str(payload.requestId)
            import hashlib
            fingerprint = hashlib.sha256(payload.model_dump_json().encode()).hexdigest()
            if job_id in v["jobs"]:
                if v["jobs"][job_id]["fingerprint"] != fingerprint:
                    raise HTTPException(409, "Request ID already used")
                return public_job(v["jobs"][job_id])
            view = dashboard(v)
            if view["usage"]["activeJobId"]:
                raise HTTPException(409, "One GPU job at a time")
            now = time.time()
            v["recent"] = [t for t in v["recent"] if now - t < 60]
            if len(v["recent"]) >= 6 or len(v["jobs"]) >= 2000:
                raise HTTPException(429, "Admission limit reached")
            cost = reservation_usd(payload.maxSeconds)
            if view["usage"]["committedUsd"] + OVERHEAD_USD + cost > min(MAX_BUDGET_USD, payload.budgetUsd):
                raise HTTPException(429, "Monthly budget exceeded")
            job = {"id": job_id, "kind": payload.kind, "status": "queued", "progress": 0,
                "createdAt": utc_now(), "maxSeconds": payload.maxSeconds,
                "estimatedCostUsd": cost, "fingerprint": fingerprint}
            v["jobs"][job_id] = job
            v["months"].setdefault(month_key(), {})[job_id] = cost
            v["recent"].append(now)
            # Reserve BEFORE spawn, without an automatic refund on ambiguity.
            await state.put.aio("ledger", v)
            call = await gpu_job.spawn.aio(job_id, payload.model_dump(mode="json"))
            job["callId"] = call.object_id
            await state.put.aio("ledger", v)
            return public_job(job)

    def find(v, job_id):
        try:
            UUID(job_id)
        except ValueError:
            raise HTTPException(404, "Job not found")
        if job_id not in v["jobs"]:
            raise HTTPException(404, "Job not found")
        return v["jobs"][job_id]

    @web.get("/jobs/{job_id}")
    async def get_job(job_id: str):
        async with control_lock():
            return public_job(find(await ledger(), job_id))

    @web.post("/jobs/{job_id}/cancel")
    async def cancel(job_id: str):
        async with control_lock():
            v = await ledger()
            j = find(v, job_id)
            if j["status"] not in TERMINAL and j.get("callId"):
                j["status"] = "cancelling"
                await state.put.aio("ledger", v)
                await modal.FunctionCall.from_id(j["callId"]).cancel.aio(terminate_containers=True)
            return public_job(j)

    @web.get("/jobs/{job_id}/result")
    async def result(job_id: str):
        async with control_lock():
            j = find(await ledger(), job_id)
            if j["status"] != "completed" or not j.get("resultPath"):
                raise HTTPException(409, "Result not ready")
            await storage.reload.aio()
            target = Path(j["resultPath"])
            if not target.is_relative_to(Path("/data/results") / job_id) or not target.is_file():
                raise HTTPException(404, "Result expired")
            return FileResponse(target, media_type=j["resultType"], filename=target.name, headers={"Cache-Control": "private, no-store"})

    return web
