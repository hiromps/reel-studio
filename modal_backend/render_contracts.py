"""Bounds for private media transfers and fixed-template cloud rendering."""
import math
import re
from pathlib import PurePosixPath

CHUNK_BYTES = 2 * 1024**2
MAX_FILE_BYTES = 512 * 1024**2
MAX_PROJECT_BYTES = 1024**3
MAX_ALL_PROJECT_BYTES = 4 * 1024**3
RETENTION_SECONDS = 7 * 86400
CLOUD_KINDS = {"remotion-render", "prepare-media"}
EXTENSIONS = {"uploads": {".mp4", ".mov", ".m4v", ".webm"},
              "fonts": {".ttf", ".otf", ".woff", ".woff2"},
              "narration": {".wav"}, "sfx": {".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"},
              "studio": {".jpg", ".png"}}


def safe_asset(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 240 or re.search(r'[\\\x00-\x1f\x7f:%?#"\x27`$<>|]', value):
        return False
    parts = value.split("/")
    return (len(parts) >= 2 and parts[0] in EXTENSIONS and
            all(p and p not in {".", ".."} for p in parts) and
            PurePosixPath(value).suffix.lower() in EXTENSIONS[parts[0]])


def finite(value, low=0, high=3600):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and low <= value <= high


def validate_render(payload):
    if not payload.sessionId:
        raise ValueError("session required")
    if payload.kind == "prepare-media":
        if payload.cuts or payload.narration:
            raise ValueError("unexpected editing data")
        return
    cuts = payload.cuts
    if not isinstance(cuts, dict) or not isinstance(cuts.get("cuts"), list) or not 1 <= len(cuts["cuts"]) <= 120:
        raise ValueError("invalid cuts")
    fps = cuts.get("fps")
    if not finite(fps, 1, 60) or int(fps) != fps:
        raise ValueError("invalid fps")
    frames = 0
    for c in cuts["cuts"]:
        if not isinstance(c, dict) or not safe_asset(c.get("src")) or not c["src"].startswith("uploads/"):
            raise ValueError("invalid source")
        a, b, rate = c.get("inSec"), c.get("outSec"), c.get("playbackRate", 1)
        if not finite(a) or not finite(b) or b <= a or not finite(rate, 0.1, 10):
            raise ValueError("invalid trim")
        frames += max(1, math.floor((b-a)/rate*fps+0.5))
    if frames / fps > 180:
        raise ValueError("initial render limit: 180 seconds")
    font = cuts.get("font")
    if font and ("/" in font or not safe_asset("fonts/" + font)):
        raise ValueError("invalid font")
    n = payload.narration
    if n is not None:
        if not isinstance(n, dict) or len(n.get("segments", [])) > 100 or len(n.get("sfx", [])) > 100:
            raise ValueError("invalid audio")
        for s in n.get("segments", []):
            if not isinstance(s, dict) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", s.get("id", "")) or s.get("needsTts"):
                raise ValueError("invalid narration")
            if not finite(s.get("at")) or not finite(s.get("durSec"), 0.001) or not finite(s.get("trimSec", 1), 0.001):
                raise ValueError("invalid narration timing")
        for s in n.get("sfx", []):
            if not isinstance(s, dict) or not safe_asset("sfx/" + str(s.get("file", ""))) or not finite(s.get("at")):
                raise ValueError("invalid sound")
    import json
    if len(json.dumps({"cuts": cuts, "narration": n})) > 512 * 1024:
        raise ValueError("editing data too large")


def required_assets(payload):
    if payload.kind != "remotion-render":
        return set()
    result = {c["src"] for c in payload.cuts["cuts"]}
    if payload.cuts.get("font"):
        result.add("fonts/" + payload.cuts["font"])
    if payload.narration:
        result.update("narration/" + s["id"] + ".wav" for s in payload.narration.get("segments", []))
        result.update("sfx/" + s["file"] for s in payload.narration.get("sfx", []))
    return result
