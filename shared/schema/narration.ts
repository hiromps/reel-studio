// narration.json（既存契約）。narration-tts.md §6 のフォーマット。
import {z} from 'zod';

export const NarrationSegmentSchema = z
  .object({
    id: z.string(), // narration/<id>.wav と一対一
    label: z.string().max(80).optional(), // 画面に表示する名前。音声ファイルの ID とは独立
    at: z.number(), // 配置秒
    durSec: z.number().optional(), // ffprobe 実測
    trimSec: z.number().positive().optional(), // 先頭から使う秒数。元の wav は残す
    text: z.string(),
  })
  .passthrough();
export type NarrationSegment = z.infer<typeof NarrationSegmentSchema>;

/**
 * 効果音 1 個。ナレーションと同じ 1 本のタイムラインに乗せるので narration.json に置く
 * （narrationGainDb / ambientGain と同じ「音の設計」の一部）。
 * 音源ファイルそのものは公開リポジトリに入れない（効果音ラボは再配布禁止）ので、
 * file は効果音ライブラリ（<dataRoot>/sfx/）からの相対パスで持つ。
 */
export const SfxSchema = z
  .object({
    id: z.string(),
    /** 動画の先頭からの配置秒 */
    at: z.number().min(0),
    /** sfx/ からの相対パス（例 alarm-clock.mp3） */
    file: z.string(),
    /** 何の役割で置いたか（自動配置・統一感の管理に使う） */
        role: z.string().optional(),
    /** 頭から使う長さ（秒）。長い素材を丸ごと鳴らさないため。省略＝全部 */
    trimSec: z.number().positive().optional(),
    /** 末尾のフェードアウト秒。trim の切り口を目立たせない */
    fadeOutSec: z.number().min(0).optional(),
    /** 音量の増減（dB）。0 が素材そのまま */
    gainDb: z.number().min(-30).max(12).optional(),
    /** 画面に出さないメモ（どの音か分かるように） */
    label: z.string().optional(),
  })
  .passthrough();
export type Sfx = z.infer<typeof SfxSchema>;

/**
 * 声の大きさ（narrationGainDb）の既定。narration.json に指定が無い案件はこれで混ぜる。
 * scripts/mix-narration.cjs は TS を読めないので同じ値を直書きしている。変えるときは両方直す
 */
export const NARRATION_GAIN_DB_DEFAULT = 8;

export const NarrationSchema = z
  .object({
    voice: z.string(),
    voiceTitle: z.string().optional(),
    latency: z.string().optional(),
    speed: z.number().optional(),
    temperature: z.number().optional(),
    videoSec: z.number().optional(),
    /** ナレーション帯域に足すゲイン（dB）。省略時は NARRATION_GAIN_DB_DEFAULT。上げると声が前に出る（混合後に -14 LUFS へ正規化される） */
    narrationGainDb: z.number().min(-12).max(12).optional(),
    /** 元素材の環境音の音量（0〜1）。既定 0.22。下げるとナレーションが相対的に立つ */
    ambientGain: z.number().min(0).max(1).optional(),
    /** 効果音の全体音量（dB）。個々の gainDb に足される */
    sfxGainDb: z.number().min(-30).max(12).optional(),
    note: z.string().optional(),
    segments: z.array(NarrationSegmentSchema),
    /** 効果音。順番は問わない（at が位置） */
    sfx: z.array(SfxSchema).optional(),
  })
  .passthrough();
export type Narration = z.infer<typeof NarrationSchema>;
