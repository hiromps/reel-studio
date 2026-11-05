import {beforeEach, expect, it, vi} from 'vitest';
import {exec} from '../core/exec';
import {probeLocalGpu} from '../core/local-gpu';
import {resolveRenderTarget, type RenderDevice} from '../shared/render-device';
import {stableHash} from '../shared/hash';
vi.mock('../core/exec', () => ({exec: vi.fn()}));
const call = vi.mocked(exec);
const result = (code = 0, stdout = '') => ({code, stdout, stderr: '', signal: null, durationMs: 1});
const resolved = (code = 0, stdout = '') => Object.assign(Promise.resolve(result(code, stdout)), {child: null as any});
beforeEach(() => {call.mockReset();});
it('GPU名だけでなく同じRemotionバイナリで1080×1920の実エンコードを確認する', async () => {
  call.mockImplementation((_bin, args) => args.includes('-encoders') ? resolved(0, ' V..... h264_nvenc\n V..... h264_videotoolbox') : args[0]?.startsWith('--query-gpu') ? resolved(0, 'NVIDIA Test GPU, 8192') : resolved());
  const device = await probeLocalGpu('renderer-ffmpeg');
  expect(device.available).toBe(true);
  expect(device.encoder).toBe(process.platform === 'darwin' ? 'h264_videotoolbox' : 'h264_nvenc');
  expect(call).toHaveBeenCalledWith('renderer-ffmpeg', expect.arrayContaining(['-c:v', device.encoder]), expect.objectContaining({timeoutMs: 15000}));
});
it('エンコーダーが列挙されてもドライバーが動かなければGPUを選ばない', async () => {
  call.mockImplementation((bin, args) => args.includes('-encoders') ? resolved(0, 'h264_nvenc h264_videotoolbox') : bin === 'ffmpeg' ? resolved() : resolved(1));
  expect((await probeLocalGpu('renderer-ffmpeg')).available).toBe(false);
});
it('検出失敗や未対応GPUでアプリを停止しない', async () => {
  call.mockRejectedValue(new Error('binary unavailable'));
  expect((await probeLocalGpu('missing')).available).toBe(false);
});
const cuts = {fps: 30, cuts: [{src: 'uploads/a.mp4', inSec: 0, outSec: 1}]};
const input = () => ({cloud: true, online: true, device: {available: true} as RenderDevice, projects: [{slug: 'test-reel', cutsHash: stableHash(cuts), narrationHash: stableHash(null)}], slug: 'test-reel', cuts, narration: null, dirty: false});
it('接続済みで編集内容とローカル素材の準備が一致した場合だけPCのGPUを優先する', () => {
  expect(resolveRenderTarget('auto', input())).toBe('pc');
  for (const patch of [{online: false}, {device: null}, {projects: []}, {dirty: true}, {cuts: {...cuts, fps: 60}}]) expect(resolveRenderTarget('auto', {...input(), ...patch})).toBe('modal');
});
it('管理者の明示的なModal/PC選択を自動判定で上書きしない', () => {
  expect(resolveRenderTarget('modal', input())).toBe('modal');
  expect(resolveRenderTarget('pc', {...input(), online: false})).toBe('pc');
});
