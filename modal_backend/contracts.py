"""Validated, bounded requests and conservative reservations; no GPU imports."""
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID
import base64
import io
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, model_validator

GPU = "RTX-PRO-6000"
GPU_PER_SECOND = 0.000842
CPU_PER_CORE_SECOND = 0.0000131
MEMORY_PER_GIB_SECOND = 0.00000222
# Charge estimates even for included storage/egress: credits are workspace-wide.
OVERHEAD_USD = 80 * 0.09 + 0.50  # model/result storage allowance + CPU API allowance
STARTUP_SECONDS = 180
SCALEDOWN_SECONDS = 2
MAX_BUDGET_USD = 25.0
MAX_JOB_SECONDS = 600
MAX_RESULT_BYTES = 64 * 1024 * 1024
TERMINAL = {"completed", "failed", "cancelled"}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def month_key():
    return datetime.now(timezone.utc).strftime("%Y-%m")


class JobInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["gpu-test", "text-to-image", "image-to-image", "image-to-video", "text-to-video"]
    prompt: str = Field(default="", max_length=2000)
    negativePrompt: str = Field(default="", max_length=1000)
    width: int = Field(default=512, ge=256, le=768, multiple_of=32)
    height: int = Field(default=512, ge=256, le=768, multiple_of=32)
    steps: int = Field(default=12, ge=1, le=40)
    frames: int = Field(default=17, ge=5, le=49)
    seed: int = Field(default=42, ge=0, le=2147483647)
    strength: float = Field(default=0.7, ge=0.1, le=0.95)
    imageBase64: str | None = Field(default=None, max_length=8 * 1024 * 1024)
    maxSeconds: int = Field(default=300, ge=30, le=MAX_JOB_SECONDS)
    allowGpu: Literal[True]
    requestId: UUID
    budgetUsd: float = Field(default=25, ge=0, le=MAX_BUDGET_USD)

    @model_validator(mode="after")
    def validate_task(self):
        if self.kind != "gpu-test" and not self.prompt.strip():
            raise ValueError("prompt required")
        if (self.frames - 1) % 4:
            raise ValueError("frames must be 4n+1")
        if self.kind.endswith("video") and max(self.width, self.height) > 640:
            raise ValueError("initial video limit: 640 pixels")
        if self.kind.startswith("image-to-") and not self.imageBase64:
            raise ValueError("input image required")
        if self.imageBase64:
            from PIL import Image
            Image.MAX_IMAGE_PIXELS = 16_000_000
            try:
                raw = base64.b64decode(self.imageBase64, validate=True)
                with Image.open(io.BytesIO(raw)) as im:
                    if im.format not in {"PNG", "JPEG", "WEBP"} or im.width * im.height > 16_000_000:
                        raise ValueError("invalid input image")
                    im.verify()
            except (OSError, ValueError, Image.DecompressionBombError):
                raise ValueError("invalid input image") from None
        return self


def reservation_usd(seconds: int) -> float:
    # GPU function is capped at four physical CPU cores and 64 GiB RAM.
    # Include cold start, idle termination, CPU/memory, egress, and 25% margin.
    rate = GPU_PER_SECOND + 4 * CPU_PER_CORE_SECOND + 64 * MEMORY_PER_GIB_SECOND
    return round(((seconds + STARTUP_SECONDS + SCALEDOWN_SECONDS) * rate + 0.05) * 1.25 + 0.04 / 16, 6)


def disk_usage_bytes(root: Path) -> int:
    """Count physical model files once; HF snapshots point to cached blobs."""
    total, seen = 0, set()
    for file in root.rglob("*"):
        try:
            if file.is_symlink() or not file.is_file():
                continue
            stat = file.stat()
            identity = (stat.st_dev, stat.st_ino)
            if identity not in seen:
                total += stat.st_size
                seen.add(identity)
        except FileNotFoundError:
            pass  # HF renames temporary files atomically during download.
    return total
