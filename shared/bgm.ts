// BGM（動画全体に敷く音楽）の既定値・候補の選び方・点検。純粋（ファイルも ffmpeg も触らない）。
//
// 音源は効果音と同じライブラリ（<dataRoot>/sfx/）に置く。効果音と混ざらないよう、
// BGM は sfx/BGM/ フォルダに入れる決まりにして、画面ではそのフォルダの曲を先に出す。
// こうすると試聴・クラウドへの同期・クラウド書き出しへの受け渡しを効果音の仕組みのまま使える。
import type {Bgm, Narration} from './schema/narration';
import type {SfxLibrary, SfxSound} from './sfx';
import {sfxCategoryOf} from './sfx';

/** BGM を置くフォルダ（sfx/ 直下）。画面の「BGM を追加」もここに保存する */
export const BGM_FOLDER = 'BGM';

/**
 * 既定値。scripts/mix-narration.cjs は TS を読めないので同じ値を直書きしている。変えるときは両方直す。
 * - gainDb -18: 声（-14 LUFS に揃う）の下に敷いて邪魔にならない目安
 * - duck: 声が鳴っている間だけさらに沈ませる（ナレーションの聞き取りやすさを優先）
 */
export const BGM_DEFAULTS = {
  gainDb: -18,
  fadeInSec: 0.5,
  fadeOutSec: 1.5,
  loop: true,
  duck: true,
} as const;

/** BGM の候補にする曲の最短の長さ（秒）。これより短いものは効果音とみなして候補の後ろに回す */
export const BGM_MIN_SEC = 8;

/** 値を埋めた BGM 設定（表示・プレビュー・点検用） */
export const bgmResolved = (b: Bgm) => ({
  gainDb: b.gainDb ?? BGM_DEFAULTS.gainDb,
  startSec: b.startSec ?? 0,
  fadeInSec: b.fadeInSec ?? BGM_DEFAULTS.fadeInSec,
  fadeOutSec: b.fadeOutSec ?? BGM_DEFAULTS.fadeOutSec,
  loop: b.loop ?? BGM_DEFAULTS.loop,
  duck: b.duck ?? BGM_DEFAULTS.duck,
});

/** ファイルが BGM フォルダの中にあるか */
export const isBgmFile = (file: string): boolean => sfxCategoryOf(file) === BGM_FOLDER;

/**
 * BGM として選べる曲。BGM フォルダの曲 → それ以外で長さが BGM_MIN_SEC 以上の音、の順。
 * 短い効果音は出さない（選んでもループで同じ音が鳴り続けるだけなので）
 */
export const bgmCandidates = (lib: SfxLibrary | null | undefined): {sound: SfxSound; inFolder: boolean}[] => {
  const sounds = lib?.sounds ?? [];
  const byLabel = (a: SfxSound, b: SfxSound) => a.label.localeCompare(b.label, 'ja');
  const folder = sounds.filter((s) => isBgmFile(s.file)).sort(byLabel);
  const others = sounds.filter((s) => !isBgmFile(s.file) && (s.durSec ?? 0) >= BGM_MIN_SEC).sort(byLabel);
  return [...folder.map((sound) => ({sound, inFolder: true})), ...others.map((sound) => ({sound, inFolder: false}))];
};

/** ミックスに載せる音（ナレーション・効果音・BGM）が 1 つでもあるか */
export const hasMixAudio = <T extends Pick<Narration, 'segments' | 'sfx' | 'bgm'>>(n: T | null | undefined): n is T => !!n && (n.segments.length > 0 || (n.sfx?.length ?? 0) > 0 || !!n.bgm?.file);

/** 画面に出す BGM の名前 */
export const bgmDisplayName = (b: Bgm, lib?: SfxLibrary | null): string => b.label || lib?.sounds.find((s) => s.file === b.file)?.label || b.file.split('/').pop() || b.file;

/** 取り込むときのファイル名を安全な形にする（フォルダ区切り・制御文字・先頭のドットを除く）。使えない名前なら null */
export const safeBgmFileName = (name: string): string | null => {
  const base = name.split(/[\\/]/).pop() ?? '';
  const m = /^(.*?)(\.[A-Za-z0-9]{2,5})$/.exec(base);
  if (!m) return null;
  const ext = m[2].toLowerCase();
  if (!BGM_EXTENSIONS.includes(ext)) return null;
  const stem = m[1].replace(/[\u0000-\u001f<>:"|?*]/g, '').replace(/^\.+/, '').trim().slice(0, 80);
  return stem ? `${stem}${ext}` : null;
};

export const BGM_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.flac'];
/** 取り込める 1 曲の上限（バイト） */
export const BGM_MAX_BYTES = 60 * 1024 * 1024;

export type BgmIssue = {severity: 'E' | 'W'; code: string; message: string};

/** BGM の点検。音源の有無・飛ばしすぎ・ループ無しで尺が足りない・大きすぎる音量 */
export const checkBgm = (bgm: Bgm | undefined, opt: {lib?: SfxLibrary | null; videoSec?: number} = {}): BgmIssue[] => {
  if (!bgm?.file) return [];
  const out: BgmIssue[] = [];
  const r = bgmResolved(bgm);
  const sound = opt.lib?.sounds.find((s) => s.file === bgm.file);
  if (opt.lib && !sound) out.push({severity: 'E', code: 'BGM_MISSING_FILE', message: `BGM の音源が見つかりません（${bgm.file}）。sfx/${BGM_FOLDER}/ に置いて「ライブラリを読み直す」か、選び直してください`});
  const dur = sound?.durSec;
  if (dur && r.startSec >= dur) out.push({severity: 'E', code: 'BGM_START_AFTER_END', message: `頭から飛ばす秒（${r.startSec.toFixed(1)}秒）が曲の長さ（${dur.toFixed(1)}秒）以上です`});
  else if (dur && opt.videoSec && !r.loop && dur - r.startSec < opt.videoSec - 0.05)
    out.push({severity: 'W', code: 'BGM_TOO_SHORT', message: `曲が動画より ${(opt.videoSec - (dur - r.startSec)).toFixed(1)} 秒短く、最後が無音になります（繰り返しをオンにすると埋まります）`});
  if (r.gainDb > -8) out.push({severity: 'W', code: 'BGM_LOUD', message: `BGM の音量（${r.gainDb} dB）が大きめです。ナレーションが聞き取りにくくなるなら -14〜-22 dB くらいに`});
  if (opt.videoSec && r.fadeInSec + r.fadeOutSec > opt.videoSec) out.push({severity: 'W', code: 'BGM_FADE_TOO_LONG', message: 'フェードイン・アウトの合計が動画より長くなっています'});
  return out;
};
