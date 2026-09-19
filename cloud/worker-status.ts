// PC ワーカーの死活と環境。ワーカーがポーリングのたびに kv['worker'] を更新し、
// GET /api/config と Settings がそれを読む（画面に「PC がオフライン」を出すため）。
import type {MosaicStatus} from '../shared/schema/settings';

/** これより長く音沙汰が無ければオフライン扱い（ポーリング間隔 15 秒 + 余裕） */
export const WORKER_ONLINE_MS = 60_000;

export type WorkerStatus = {
  lastSeen: string;
  host: string | null;
  node: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
  claude: boolean;
  claudeBin: string | null;
  claudeVersion: string | null;
  tts: boolean;
  freeMemMB: number;
  totalMemMB: number;
  /** uploads/ の直下にある素材フォルダ（画面の素材フォルダ選択に出す） */
  uploadsFolders: string[];
  mosaic: MosaicStatus | null;
  /** いま PC で走っているジョブ（画面の表示ではなく、取りこぼし検知の参考） */
  running: {slug: string; type: string}[];
};
