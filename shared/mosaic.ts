// 顔モザイク（deface の顔検出器を使う）の設定値と、検出結果の要約。純粋（ファイルも子プロセスも触らない）。
// 実行は core/mosaic.ts → scripts/face-mosaic.py。
import {z} from 'zod';

/**
 * 既定値の根拠（2026-09-17 実測・CenterFace / 検出 720x1280）:
 * - 料理の寄り（卵黄・麻婆豆腐・パスタ・刺身）を顔と取り違えたスコアは最大 0.59。
 *   実際の顔は正面で 0.85〜0.93、店の奥に小さく映る客で 0.6〜0.85。deface の既定 0.2 だと
 *   麻婆豆腐 1 フレームに 8 個「顔」が出るので、料理動画向けに 0.6 まで上げる
 * - 0.6 でも料理で 1 フレームだけ出ることがあるため、前後のフレームに裏付けの無い検出は捨てる（スクリプト側）
 */
export const MosaicParamsSchema = z.object({
  /** 顔とみなすスコア。下げるほど拾うが、料理を顔と取り違えやすくなる */
  threshold: z.number().min(0.2).max(0.95).default(0.6),
  /** 顔 1 つを何マスに割るか。少ないほど粗い */
  cells: z.number().int().min(4).max(24).default(8),
  /** 検出した枠を何倍に広げて隠すか（髪・輪郭まで隠す） */
  maskScale: z.number().min(1).max(2).default(1.3),
  /** 検出に使う短辺の px（0 = 原寸）。小さいほど速いが、遠くの小さな顔を落とす */
  detectShort: z.number().int().min(0).max(2160).default(720),
  /** 何フレームに 1 回検出するか（CPU で遅いとき 2） */
  detectEvery: z.number().int().min(1).max(4).default(1),
  /** 検出した位置を前後何秒まで隠し続けるか（取りこぼしたフレームで顔が一瞬映らないように） */
  holdSec: z.number().min(0).max(0.5).default(0.1),
});
export type MosaicParams = z.infer<typeof MosaicParamsSchema>;

export const MOSAIC_DEFAULTS: MosaicParams = MosaicParamsSchema.parse({});

/** 画面・CLI から来た部分的な指定を既定値で埋め、範囲外は弾く */
export const resolveMosaicParams = (over: Partial<MosaicParams> = {}): MosaicParams => {
  const defined = Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined && !(typeof v === 'number' && Number.isNaN(v))));
  return MosaicParamsSchema.parse({...MOSAIC_DEFAULTS, ...defined});
};

export const holdFrames = (holdSec: number, fps: number): number => Math.max(0, Math.round(holdSec * fps));

export const FaceSpanSchema = z.object({startSec: z.number(), endSec: z.number(), maxFaces: z.number().int()});
export type FaceSpan = z.infer<typeof FaceSpanSchema>;

/** scripts/face-mosaic.py が --report に書く JSON */
export const MosaicReportSchema = z.object({
  frames: z.number().int().min(1),
  fps: z.number().positive(),
  width: z.number().int(),
  height: z.number().int(),
  /** フレームごとの顔の数（前後に広げる前。前後のフレームで裏付けの取れたものだけ） */
  faces: z.array(z.number().int().min(0)),
  engine: z.string(),
  elapsedSec: z.number(),
});
export type MosaicReport = z.infer<typeof MosaicReportSchema>;

/**
 * 顔が映っている区間。gapSec 以内の切れ目はつなげる（取りこぼしで区間が細切れにならないように）。
 * 秒はフレームの頭から次のフレームの頭まで。
 */
export const faceSpans = (faces: readonly number[], fps: number, gapSec = 0.25): FaceSpan[] => {
  const gap = Math.max(0, Math.round(gapSec * fps));
  const spans: {start: number; end: number; max: number}[] = [];
  faces.forEach((n, i) => {
    if (n <= 0) return;
    const last = spans[spans.length - 1];
    if (last && i - last.end - 1 <= gap) {
      last.end = i;
      last.max = Math.max(last.max, n);
    } else spans.push({start: i, end: i, max: n});
  });
  const sec = (f: number) => Math.round((f / fps) * 1000) / 1000;
  return spans.map((s) => ({startSec: sec(s.start), endSec: sec(s.end + 1), maxFaces: s.max}));
};

export type MosaicSummary = {frames: number; framesWithFaces: number; maxFaces: number; spans: FaceSpan[]; faceSec: number};

export const summarizeMosaicReport = (r: MosaicReport): MosaicSummary => {
  const spans = faceSpans(r.faces, r.fps);
  return {
    frames: r.frames,
    framesWithFaces: r.faces.filter((n) => n > 0).length,
    maxFaces: r.faces.reduce((m, n) => Math.max(m, n), 0),
    spans,
    faceSec: Math.round(spans.reduce((s, x) => s + (x.endSec - x.startSec), 0) * 100) / 100,
  };
};

export const MosaicInfoSchema = z.object({
  /** true = catalog の src は顔にモザイクをかけたファイル（元のファイルは original に退避してある） */
  applied: z.boolean(),
  /** 退避した元のファイル（.studio からの相対）。applied のときだけ */
  original: z.string().optional(),
  checkedAt: z.string(),
  params: MosaicParamsSchema,
  frames: z.number().int(),
  framesWithFaces: z.number().int(),
  maxFaces: z.number().int(),
  spans: z.array(FaceSpanSchema).default([]),
  /** 検出に使ったもの（例 `deface 1.5.0 / DmlExecutionProvider`） */
  engine: z.string().default(''),
});
export type MosaicInfo = z.infer<typeof MosaicInfoSchema>;

const fmtSec = (s: number) => `${Math.round(s * 10) / 10}`;

/** 一覧・詳細に出す 1 行 */
export const mosaicLabel = (m: MosaicInfo | undefined): string => {
  if (!m) return '未チェック';
  if (!m.applied) return '顔なし（確認済み）';
  const sec = m.spans.reduce((s, x) => s + (x.endSec - x.startSec), 0);
  return `モザイク済み（顔 ${fmtSec(sec)} 秒・最大 ${m.maxFaces} 人）`;
};

/** 区間の一覧（「0.0〜1.2 秒 / 3.4〜5.0 秒」） */
export const spansText = (spans: readonly FaceSpan[], max = 4): string => {
  if (!spans.length) return '';
  const head = spans.slice(0, max).map((s) => `${fmtSec(s.startSec)}〜${fmtSec(s.endSec)} 秒`);
  return spans.length > max ? `${head.join(' / ')} ほか ${spans.length - max} か所` : head.join(' / ');
};
