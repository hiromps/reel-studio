"""Bounded model subprocess. No arbitrary workflows, URLs, code or model IDs."""
import base64
import io
import json
from pathlib import Path
import sys

IMAGE_MODEL = "segmind/SSD-1B"
IMAGE_REVISION = "60987f37e94cd59c36b1cba832b9f97b57395a10"
T2V_MODEL = "Wan-AI/Wan2.1-T2V-1.3B-Diffusers"
T2V_REVISION = "0fad780a534b6463e45facd96134c9f345acfa5b"
I2V_MODEL = "Wan-AI/Wan2.2-TI2V-5B-Diffusers"
I2V_REVISION = "b8fff7315c768468a5333511427288870b2e9635"


def gpu_info():
    import torch
    from modal_backend.contracts import utc_now
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA_UNAVAILABLE")
    x = torch.ones((64, 64), device="cuda")
    assert (x @ x)[0, 0].item() == 64
    torch.cuda.synchronize()
    props = torch.cuda.get_device_properties(0)
    free, total = torch.cuda.mem_get_info()
    return {"name": str(props.name), "memoryTotalMiB": round(total / 1024**2),
            "memoryUsedMiB": round((total - free) / 1024**2), "cudaAvailable": True,
            "cudaVersion": str(torch.version.cuda), "torchVersion": str(torch.__version__),
            "capability": f"{props.major}.{props.minor}", "checkedAt": utc_now()}


def generate(request_file, progress_file, result_file, job_id):
    import torch
    p = json.loads(Path(request_file).read_text())
    info = gpu_info()
    if p["kind"] == "gpu-test":
        Path(result_file).write_text(json.dumps({"gpuInfo": info}))
        return
    from PIL import Image, ImageOps
    from diffusers import AutoPipelineForText2Image, AutoPipelineForImage2Image
    from diffusers import AutoencoderKLWan, WanPipeline, WanImageToVideoPipeline
    from diffusers.utils import export_to_video

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable")
    torch.set_num_threads(8)
    generator = torch.Generator(device="cuda").manual_seed(p["seed"])
    output_dir = Path("/data/results") / job_id
    output_dir.mkdir(parents=True, exist_ok=True)

    def progress(status, percent):
        temp = Path(str(progress_file) + ".tmp")
        temp.write_text(json.dumps({"status": status, "percent": percent}))
        temp.replace(progress_file)

    def step_callback(pipe, step, _timestep, callback_kwargs):
        progress("running", min(94, 10 + round(80 * (step + 1) / max(1, p["steps"]))))
        return callback_kwargs

    image = None
    if p.get("imageBase64"):
        with Image.open(io.BytesIO(base64.b64decode(p["imageBase64"], validate=True))) as raw:
            image = ImageOps.fit(ImageOps.exif_transpose(raw).convert("RGB"), (p["width"], p["height"]), method=Image.Resampling.LANCZOS)

    progress("loading", 2)
    common = dict(prompt=p["prompt"], negative_prompt=p["negativePrompt"],
                  width=p["width"], height=p["height"], generator=generator,
                  num_inference_steps=p["steps"], callback_on_step_end=step_callback)

    if p["kind"] in {"text-to-image", "image-to-image"}:
        cls = AutoPipelineForImage2Image if p["kind"] == "image-to-image" else AutoPipelineForText2Image
        pipe = cls.from_pretrained(IMAGE_MODEL, revision=IMAGE_REVISION,
                                  torch_dtype=torch.float16, variant="fp16", use_safetensors=True)
        pipe.to("cuda")
        pipe.vae.enable_slicing()
        if image is not None:
            common.update(image=image, strength=p["strength"])
        progress("running", 10)
        output = pipe(**common, guidance_scale=9.0).images[0]
        target = output_dir / "result.png"
        output.save(target, format="PNG")
        result = {"path": str(target), "resultType": "image/png", "model": IMAGE_MODEL}
    else:
        is_i2v = p["kind"] == "image-to-video"
        model, revision = (I2V_MODEL, I2V_REVISION) if is_i2v else (T2V_MODEL, T2V_REVISION)
        vae = AutoencoderKLWan.from_pretrained(model, revision=revision, subfolder="vae", torch_dtype=torch.float32)
        cls = WanImageToVideoPipeline if is_i2v else WanPipeline
        options = {"image_encoder": None, "image_processor": None} if is_i2v else {}
        pipe = cls.from_pretrained(model, revision=revision, vae=vae,
                                   torch_dtype=torch.bfloat16, **options)
        pipe.to("cuda")
        pipe.vae.enable_tiling()
        if is_i2v:
            common.update(image=image)
        progress("running", 10)
        output = pipe(**common, num_frames=p["frames"], guidance_scale=5.0).frames[0]
        progress("running", 95)
        target = output_dir / "result.mp4"
        export_to_video(output, str(target), fps=16)
        result = {"path": str(target), "resultType": "video/mp4", "model": model}
    result["gpuInfo"] = gpu_info()
    Path(result_file).write_text(json.dumps(result))


if __name__ == "__main__":
    try:
        generate(*sys.argv[1:])
    except Exception as error:
        import os
        import traceback
        diagnostic = traceback.format_exc()
        # Private operator logs only; redact credentials and user prompt input.
        for name, value in os.environ.items():
            if any(word in name.upper() for word in ("TOKEN", "SECRET", "KEY")) and len(value) >= 8:
                diagnostic = diagnostic.replace(value, "[redacted]")
        try:
            payload = json.loads(Path(sys.argv[1]).read_text())
            for key in ("prompt", "negativePrompt", "imageBase64"):
                if payload.get(key):
                    diagnostic = diagnostic.replace(payload[key], "[input]")
        except Exception:
            pass
        Path(sys.argv[3]).write_text(json.dumps({"error": type(error).__name__, "diagnostic": diagnostic[-6000:]}))
        sys.exit(1)
