import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {exec} from './exec';
import {studioConfig} from '../studio.config';
import {listProjects, readCuts, readNarration} from './project';
import {stableHash} from '../shared/hash';
import type {RenderDevice, LocalRenderProject} from '../shared/render-device';

const cache = new Map<string, {at: number; value: Promise<RenderDevice>}>();
export const rendererFfmpeg = (projectDir = studioConfig.templateDir): string => {
  const require = createRequire(path.join(projectDir, 'package.json'));
  const renderer = require('@remotion/renderer') as {RenderInternals: {getExecutablePath: (input: unknown) => string}};
  return renderer.RenderInternals.getExecutablePath({type: 'ffmpeg', binariesDirectory: null, indent: false, logLevel: 'error'});
};

/** Test the same binary used by Remotion; listing an encoder alone does not verify a working driver. */
export async function probeLocalGpu(binary: string): Promise<RenderDevice> {
  const device: RenderDevice = {available: false, encoder: null, name: null, memoryMiB: null, checkedAt: new Date().toISOString(), reason: '対応するGPUエンコーダーを利用できません。CPUまたはModalで書き出せます'};
  const encoder = process.platform === 'darwin' ? 'h264_videotoolbox' : 'h264_nvenc';
  let temp: string | undefined;
  try {
    const listing = await exec(binary, ['-hide_banner', '-encoders'], {timeoutMs: 8000, keepChars: 64000});
    if (listing.code !== 0 || !new RegExp(`\\b${encoder}\\b`).test(listing.stdout)) return device;
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-gpu-probe-'));
    const frame = path.join(temp, 'input.mp4'), output = path.join(temp, 'output.mp4');
    const fixture = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=1080x1920:r=30:d=0.04', '-frames:v', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', frame], {timeoutMs: 10000});
    if (fixture.code !== 0) return device;
    const tested = await exec(binary, ['-hide_banner', '-loglevel', 'error', '-i', frame, '-frames:v', '1', '-c:v', encoder, '-b:v', '8M', '-y', output], {cwd: path.dirname(binary), timeoutMs: 15000, keepChars: 4000});
    if (tested.code !== 0) {device.reason = 'GPUの実動作テストに失敗しました。ドライバー・利用状況を確認してください。CPUまたはModalは利用できます'; return device;}
    device.available = true; device.encoder = encoder; device.name = encoder === 'h264_nvenc' ? 'NVIDIA GPU' : 'VideoToolbox対応GPU';
    device.reason = '1080×1920のH.264エンコードを実動作で確認しました';
    if (encoder === 'h264_nvenc') {
      const smi = process.platform === 'win32' && fs.existsSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/nvidia-smi.exe')) ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/nvidia-smi.exe') : 'nvidia-smi';
      const info = await exec(smi, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {timeoutMs: 3000, keepChars: 2000}).catch(() => null);
      const match = info?.code === 0 ? /^([^\r\n,]{1,150}),\s*(\d+)/.exec(info.stdout) : null;
      if (match) {device.name = match[1].trim(); device.memoryMiB = Number(match[2]);}
    }
    return device;
  } catch {return device;}
  finally {if (temp) {for (const f of ['input.mp4', 'output.mp4']) fs.rmSync(path.join(temp, f), {force: true}); fs.rmdirSync(temp);}}
}

export function detectLocalGpu(projectDir = studioConfig.templateDir): Promise<RenderDevice> {
  let binary: string;
  try {binary = rendererFfmpeg(projectDir);} catch {return Promise.resolve({available: false, encoder: null, name: null, memoryMiB: null, checkedAt: new Date().toISOString(), reason: '書き出しエンジンの準備が必要です'});}
  const old = cache.get(binary);
  if (old && Date.now() - old.at < 5 * 60_000) return old.value;
  const value = probeLocalGpu(binary); cache.set(binary, {at: Date.now(), value}); return value;
}

/** Publish readiness, never local paths. Cloud-only or changed media must not be routed to this PC. */
export function localGpuProjects(): LocalRenderProject[] {
  const ready: LocalRenderProject[] = [];
  for (const p of listProjects().slice(0, 128)) {
    try {
      const cuts = readCuts(p.dir), narration = readNarration(p.dir);
      const publicDir = path.resolve(p.dir, 'public');
      if (!cuts.cuts.length || cuts.cuts.some(c => {const f = path.resolve(publicDir, c.src); return !f.startsWith(publicDir + path.sep) || !fs.existsSync(f);})) continue;
      if (narration?.segments.some(s => s.needsTts || !s.durSec || !/^[\w-]+$/.test(s.id) || !fs.existsSync(path.join(p.dir, 'narration', s.id + '.wav')))) continue;
      if (narration?.sfx?.some(s => {const root = path.resolve(studioConfig.sfxDir), f = path.resolve(root, s.file); return !f.startsWith(root + path.sep) || !fs.existsSync(f);})) continue;
      ready.push({slug: p.slug, cutsHash: stableHash(cuts), narrationHash: stableHash(narration)});
    } catch { /* Incomplete projects are not candidates for automatic routing. */ }
  }
  return ready;
}
