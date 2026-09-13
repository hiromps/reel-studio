// Fish Audio の TTS を直接叩いて narration/<id>.wav を作る。
//
// これまでは MCP の fish_audio_tts を Claude 経由で呼んでいたが、GUI から音声を作れないと
// 「テロップまで作ったのに最後だけ人手」になるので、HTTP API を直接呼ぶ。
// 叩き方は MCP パッケージ（@zhoujinandrew/fish-audio-mcp-server → fish-audio-sdk）と同一：
//   POST https://api.fish.audio/v1/tts
//   Authorization: Bearer <FISH_API_KEY> / developer-id: <固定> / model: <FISH_MODEL_ID>
//   body: {text, format, latency, prosody:{speed, volume}, reference_id, ...}
// 仕様の根拠は .claude/skills/hiro-daihon/references/narration-tts.md §2。
import fs from 'node:fs';
import path from 'node:path';
import {execOk} from './exec';
import {readBrief, readNarration, writeNarration} from './project';
import {PERSONAS, getPersona} from '../shared/personas';
import {checkNarration} from '../shared/narration';
import {studioConfig} from '../studio.config';
import type {Narration, NarrationSegment} from '../shared/schema/narration';

const ENDPOINT = 'https://api.fish.audio/v1/tts';
/** fish-audio-sdk が既定で送っている値（session.js のコンストラクタ引数） */
const DEVELOPER_ID = '6322d9df15d044e7b928de27c863480f';
const DEFAULT_MODEL = 's2.1-pro-free';

type FishEnv = {apiKey: string; modelId: string; source: string};

const readJsonSafe = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** `${FOO}` のような参照はそのままでは使えない（展開元はここには無い） */
const literal = (v: unknown): string | null => (typeof v === 'string' && v && !v.startsWith('${') ? v : null);

const envBlock = (file: string): Record<string, unknown> => {
  const j = readJsonSafe(file);
  const out: Record<string, unknown> = {};
  const env = j?.env;
  if (env && typeof env === 'object') Object.assign(out, env);
  // .mcp.json は mcpServers.<name>.env に入っている
  const servers = j?.mcpServers;
  if (servers && typeof servers === 'object')
    for (const s of Object.values(servers as Record<string, {env?: Record<string, unknown>}>)) if (s?.env) for (const [k, v] of Object.entries(s.env)) if (!(k in out)) out[k] = v;
  return out;
};

let cached: FishEnv | null | undefined;

/**
 * FISH_API_KEY の在り処を順に探す。**値は決してログに出さない**
 * （ワークスペース規約：秘密は存在確認とキー名のみ）。
 */
export const fishEnv = (): FishEnv | null => {
  if (cached !== undefined) return cached;
  const candidates: {file: string; label: string}[] = [
    {file: path.join(studioConfig.repoRoot, '.claude', 'settings.local.json'), label: '.claude/settings.local.json'},
    {file: path.join(studioConfig.repoRoot, '.mcp.json'), label: '.mcp.json'},
    {file: path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', 'settings.json'), label: '~/.claude/settings.json'},
  ];
  let apiKey = literal(process.env.FISH_API_KEY);
  let modelId = literal(process.env.FISH_MODEL_ID);
  let source = apiKey ? '環境変数' : '';
  for (const c of candidates) {
    if (apiKey && modelId) break;
    const env = envBlock(c.file);
    if (!apiKey) {
      const k = literal(env.FISH_API_KEY);
      if (k) {
        apiKey = k;
        source = c.label;
      }
    }
    if (!modelId) modelId = literal(env.FISH_MODEL_ID);
  }
  cached = apiKey ? {apiKey, modelId: modelId ?? DEFAULT_MODEL, source} : null;
  return cached;
};

/** テストや設定変更後に読み直す */
export const resetFishEnv = () => {
  cached = undefined;
};

export const ttsAvailable = (): boolean => !!fishEnv();

// ───────────────────────── ボイス一覧 ─────────────────────────
/**
 * そのボイスが Fish Audio にまだあるか。消されたモデルを一覧に出したり、
 * 気づかないまま生成に失敗したりしないための確認。結果は 1 プロセス内で覚えておく。
 */
const voiceAlive = new Map<string, boolean>();

export const voiceExists = async (id: string, opt: {signal?: AbortSignal} = {}): Promise<boolean | null> => {
  const env = fishEnv();
  if (!env || !id) return null; // 鍵が無いときは判断しない（消えていると決めつけない）
  const cached = voiceAlive.get(id);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`https://api.fish.audio/model/${encodeURIComponent(id)}`, {
      headers: {Authorization: `Bearer ${env.apiKey}`, 'developer-id': DEVELOPER_ID},
      signal: opt.signal,
    });
    if (res.status === 404) {
      voiceAlive.set(id, false);
      return false;
    }
    if (!res.ok) return null; // 5xx 等は「分からない」扱い
    voiceAlive.set(id, true);
    return true;
  } catch {
    return null;
  }
};


export type Voice = {
  /** reference_id（narration.json の voice に入る値） */
  id: string;
  title: string;
  /**
   * own = 自分が Fish Audio に登録したモデル / persona = personas.ts の既定ボイス /
   * extra = studio.config.ts の voices に足したもの（他人の公開モデル）
   */
  source: 'own' | 'persona' | 'extra';
  /** このボイスを既定にしている人格 */
  personas: string[];
  languages?: string[];
  state?: string;
};

type ModelListItem = {_id?: string; id?: string; title?: string; state?: string; languages?: string[]};

/**
 * 選べるボイスの一覧。
 * 自分の登録モデル（Fish Audio の `GET /model?self=true`）に、personas.ts が使っているボイスを足す。
 * 人格のボイスには他人の公開モデルが混ざっていて self には出てこないため、両方を出さないと選べない。
 * 鍵が無い・API が落ちているときは人格のボイスだけ返す（画面が空にならないように）。
 */
export const listVoices = async (opt: {signal?: AbortSignal} = {}): Promise<{voices: Voice[]; apiError?: string}> => {
  const byId = new Map<string, Voice>();
  for (const p of Object.values(PERSONAS)) {
    if (!p.narration.voiceId) continue; // ボイス未定の人格は選択肢に出さない（空 id を選ばせない）
    const cur = byId.get(p.narration.voiceId);
    if (cur) cur.personas.push(p.id);
    else byId.set(p.narration.voiceId, {id: p.narration.voiceId, title: p.narration.voiceTitle, source: 'persona', personas: [p.id]});
  }

  // studio.config.ts に足したボイス。**こちらで付けた名前を優先する**
  for (const v of studioConfig.voices) {
    if (!v.id) continue;
    const cur = byId.get(v.id);
    byId.set(v.id, {id: v.id, title: v.title || cur?.title || v.id, source: cur?.source ?? 'extra', personas: cur?.personas ?? []});
  }
  const named = new Set(studioConfig.voices.map((v) => v.id));

  const env = fishEnv();
  let apiError: string | undefined;
  if (env) {
    try {
      const res = await fetch('https://api.fish.audio/model?self=true&page_size=100', {
        headers: {Authorization: `Bearer ${env.apiKey}`, 'developer-id': DEVELOPER_ID},
        signal: opt.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {items?: ModelListItem[]};
      for (const it of data.items ?? []) {
        const id = it._id ?? it.id;
        if (!id) continue;
        const cur = byId.get(id);
        // 自分のモデルの方が正しい題名なので人格側の表示名より優先する。
        // ただし studio.config.ts で名前を付けたものは、その呼び名を残す
        if (cur) byId.set(id, {...cur, title: named.has(id) ? cur.title : (it.title ?? cur.title), source: 'own', languages: it.languages, state: it.state});
        else byId.set(id, {id, title: it.title ?? id, source: 'own', personas: [], languages: it.languages, state: it.state});
      }
    } catch (e) {
      apiError = e instanceof Error ? e.message : String(e);
    }
  } else {
    apiError = 'FISH_API_KEY が見つかりません（人格のボイスだけ出しています）';
  }

  // personas.ts のボイスは他人の公開モデルのことがあり、消されていても気づけない。
  // 一覧に出す前に生存を確認して、消えているものは落とす（自分の登録モデルは self に出た＝生きている）
  const dead: string[] = [];
  await Promise.all(
    [...byId.values()]
      .filter((v) => v.source === 'persona' || v.source === 'extra')
      .map(async (v) => {
        if ((await voiceExists(v.id, {signal: opt.signal})) === false) {
          dead.push(v.title);
          byId.delete(v.id);
        }
      }),
  );
  if (dead.length) apiError = [apiError, `${dead.join('・')} は Fish Audio に無いので一覧から外しました`].filter(Boolean).join(' / ');

  // 人格が使っているものを先に、その中は人格の並び順で
  const order = Object.keys(PERSONAS);
  const rank = (v: Voice) => (v.personas.length ? Math.min(...v.personas.map((x) => order.indexOf(x))) : v.source === 'extra' ? 50 : 99);
  const voices = [...byId.values()].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title, 'ja'));
  return {voices, apiError};
};

/** 音声を作り直す必要があるブロック（本文が変わった or wav が無い） */
export const needsTtsIds = (dir: string, narration: Narration): string[] =>
  narration.segments.filter((s) => (s as {needsTts?: boolean}).needsTts || !fs.existsSync(path.join(dir, 'narration', `${s.id}.wav`))).map((s) => s.id);

const wavDurationSec = async (file: string): Promise<number> => {
  const r = await execOk('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nokey=1', file]);
  return Math.round((Number(r.stdout.trim()) || 0) * 1000) / 1000;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('中断されました'));
    }, {once: true});
  });

export type TtsBody = {
  text: string;
  format: 'wav';
  latency: string;
  chunk_length: number;
  normalize: boolean;
  references: never[];
  reference_id: string;
  prosody: {speed: number; volume: number};
};

/** narration.json 1 ブロック分のリクエスト body。sample_rate は wav では 400 になるので入れない */
export const ttsBody = (text: string, voiceId: string, speed: number, latency: string): TtsBody => ({
  text,
  format: 'wav',
  latency,
  chunk_length: 200,
  normalize: true,
  references: [],
  reference_id: voiceId,
  prosody: {speed, volume: 0},
});

/**
 * 「長さが不自然」と判断する閾値。文字数から見た想定尺の何倍まで許すか。
 * Fish Audio は同じ入力でも尺が 2 倍以上ばらつくので、ここを狭くすると引き直しばかりになる。
 */
const OUTLIER_RATIO = 2.5;
/** 短い文では比率だけだと厳しすぎるので、この秒数ぶんは無条件に許す */
const OUTLIER_MARGIN_SEC = 1.0;
/** 引き直す回数の上限（超えたらそのまま採用して警告する） */
const OUTLIER_RETRIES = 2;

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 1 ブロック生成。失敗は数回まで待って再試行する */
const synth = async (env: FishEnv, body: TtsBody, signal?: AbortSignal): Promise<Buffer> => {
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        'Content-Type': 'application/json',
        'developer-id': DEVELOPER_ID,
        model: env.modelId,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      // 中身が wav でなければ（エラー JSON がそのまま返るなど）ここで気づけるようにする
      if (buf.length < 64 || buf.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error(`wav が返ってきませんでした（${buf.length} バイト: ${buf.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ')}）`);
      return buf;
    }
    const detail = (await res.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
    lastErr = `HTTP ${res.status} ${detail}`;
    if (res.status === 401 || res.status === 403) throw new Error(`Fish Audio の認証に失敗しました（${lastErr}）。FISH_API_KEY を確認してください`);
    if (!RETRY_STATUS.has(res.status) || attempt === 3) break;
    await sleep(attempt * 2000, signal);
  }
  throw new Error(`Fish Audio の生成に失敗しました（${lastErr}）`);
};

/**
 * 試聴用。ファイルを一切作らず wav のバイト列だけ返す。
 * 「この速度でどう聞こえるか」を、案件の音声を壊さずに確かめるために使う。
 */
export const synthPreview = async (
  text: string,
  opt: {voice: string; speed?: number; latency?: string; signal?: AbortSignal},
): Promise<Buffer> => {
  const env = fishEnv();
  if (!env) throw new Error('FISH_API_KEY が見つかりません');
  const t = text.trim();
  if (!t) throw new Error('本文が空です');
  if (/[\r\n]/.test(t)) throw new Error('本文に改行があります（1 ブロック 1 文）');
  if (!opt.voice) throw new Error('ボイスが未設定です');
  const speed = opt.speed ?? 1.6;
  if (!(speed >= 0.5 && speed <= 2)) throw new Error(`speed が範囲外です: ${speed}（0.5〜2.0）`);
  // 長文を丸ごと作ると待たされるので、試聴は先頭 60 文字まで
  return synth(env, ttsBody([...t].slice(0, 60).join(''), opt.voice, speed, opt.latency || 'normal'), opt.signal);
};

/**
 * 1 本だけ好きな文を好きな場所に書き出す（トライアルリールのフック差し替え用）。
 * narration.json を経由しないので、案件の音声を壊さずに別 id の wav を作れる。
 */
export const synthOne = async (
  text: string,
  opt: {voice: string; speed?: number; latency?: string; out: string; signal?: AbortSignal},
): Promise<number> => {
  const env = fishEnv();
  if (!env) throw new Error('FISH_API_KEY が見つかりません');
  if (!text.trim()) throw new Error('本文が空です');
  if (/[\r\n]/.test(text)) throw new Error('本文に改行があります（1 ブロック 1 文）');
  if (!opt.voice) throw new Error('ボイスが未設定です');
  const speed = opt.speed ?? 1.6;
  if (!(speed >= 0.5 && speed <= 2)) throw new Error(`speed が範囲外です: ${speed}`);
  fs.mkdirSync(path.dirname(opt.out), {recursive: true});
  const buf = await synth(env, ttsBody(text.trim(), opt.voice, speed, opt.latency || 'normal'), opt.signal);
  fs.writeFileSync(opt.out, buf);
  return wavDurationSec(opt.out);
};

export type TtsOptions = {
  /** 音声が既にあるブロックも作り直す */
  force?: boolean;
  /** 指定した id だけ（省略＝要再生成のもの全部） */
  ids?: string[];
  onLine?: (line: string) => void;
  onProgress?: (done: number, total: number, phase: string) => void;
  signal?: AbortSignal;
};

export type TtsResult = {made: string[]; skipped: string[]; chars: number; voice: string; modelId: string};

/**
 * narration.json のブロックを wav にする。
 * 1 本作るごとに narration.json を書き戻すので、途中で止めても済んだ分は残る。
 */
export const generateTts = async (projectDir: string, opt: TtsOptions = {}): Promise<TtsResult> => {
  const log = opt.onLine ?? (() => {});
  const env = fishEnv();
  if (!env) throw new Error('FISH_API_KEY が見つかりません。.claude/settings.local.json の env か、環境変数に設定してください');
  const narration = readNarration(projectDir);
  if (!narration) throw new Error('narration.json が無いので音声を作れません（先に「AI にナレーションを書いてもらう」）');
  if (!narration.segments.length) throw new Error('narration.json の segments が空です');

  const brief = readBrief(projectDir);
  const persona = brief ? getPersona(brief.persona) : null;
  const voice = narration.voice || persona?.narration.voiceId;
  if (!voice)
    throw new Error(
      `ボイスが未設定です（人格 ${brief?.persona ?? '?'}）。Render の「ボイス」で選ぶか、shared/personas.ts の voiceId を入れてください`,
    );
  if ((await voiceExists(voice, {signal: opt.signal})) === false)
    throw new Error(`このボイスは Fish Audio にありません（消された可能性）: ${narration.voiceTitle ?? voice}\n  Render の「ボイス」で選び直してください`);
  const speed = narration.speed ?? persona?.narration.speed ?? 1.6;
  if (!(speed >= 0.5 && speed <= 2)) throw new Error(`speed が範囲外です: ${speed}（0.5〜2.0）`);
  const latency = narration.latency || 'normal';

  const outDir = path.join(projectDir, 'narration');
  fs.mkdirSync(outDir, {recursive: true});

  const want = new Set(opt.ids ?? (opt.force ? narration.segments.map((s) => s.id) : needsTtsIds(projectDir, narration)));
  const targets = narration.segments.filter((s) => want.has(s.id));
  const skipped = narration.segments.filter((s) => !want.has(s.id)).map((s) => s.id);
  if (!targets.length) {
    log('作り直しが必要なブロックはありません');
    return {made: [], skipped, chars: 0, voice, modelId: env.modelId};
  }
  const empty = targets.find((s) => !s.text.trim());
  if (empty) throw new Error(`${empty.id} の本文が空です。先に文言を入れてください`);
  const multiline = targets.find((s) => /[\r\n]/.test(s.text));
  if (multiline) throw new Error(`${multiline.id} の本文に改行があります。1 ブロック 1 文にしてください`);

  const totalChars = targets.reduce((n, s) => n + [...s.text].length, 0);
  log(`ボイス ${narration.voiceTitle ?? voice} / speed ${speed} / latency ${latency} / model ${env.modelId}（キー: ${env.source}）`);
  log(`${targets.length} ブロック・${totalChars} 文字を生成します`);

  const made: string[] = [];
  // 書き戻しは id で引く（GUI 側で並べ替えられていても取り違えない）
  const patch = (id: string, fn: (s: NarrationSegment) => void) => {
    const cur = readNarration(projectDir);
    if (!cur) return;
    const seg = cur.segments.find((s) => s.id === id);
    if (!seg) return;
    fn(seg);
    writeNarration(projectDir, cur);
  };

  // Fish Audio の出力は決定的でなく、**同じ文でも極端に長い当たり**が出る
  // （実測: 21 文字で 1.02〜29.78 秒。2026-09-12）。そのまま採用すると後続のブロックに
  // かぶって動画全体の音が壊れるので、文字数から見た妥当な範囲を外れたら引き直す。
  const cpsMeasured = persona?.narration.charsPerSecMeasured ?? 11;
  const outlier = (chars: number, dur: number) => {
    const expect = chars / cpsMeasured;
    return dur > expect * OUTLIER_RATIO + OUTLIER_MARGIN_SEC || dur < expect / OUTLIER_RATIO - OUTLIER_MARGIN_SEC;
  };
  const rerolled: string[] = [];

  for (const [i, seg] of targets.entries()) {
    if (opt.signal?.aborted) break;
    opt.onProgress?.(i, targets.length, seg.id);
    const file = path.join(outDir, `${seg.id}.wav`);
    const chars = [...seg.text].length;
    let dur = 0;
    let tries = 0;
    for (;;) {
      tries++;
      const buf = await synth(env, ttsBody(seg.text.trim(), voice, speed, latency), opt.signal);
      fs.writeFileSync(file, buf);
      dur = await wavDurationSec(file);
      if (!outlier(chars, dur) || tries > OUTLIER_RETRIES) break;
      log(`  ${seg.id} ${dur.toFixed(2)}s は ${chars}字 に対して不自然なので引き直します（${tries}/${OUTLIER_RETRIES}）`);
      rerolled.push(seg.id);
    }
    patch(seg.id, (s) => {
      s.durSec = dur;
      delete (s as {needsTts?: boolean}).needsTts;
    });
    made.push(seg.id);
    const note = outlier(chars, dur) ? ' ← 引き直しても不自然。聴いて確認してください' : tries > 1 ? `（${tries} 回目）` : '';
    log(`  ${seg.id} ${chars}字 → ${dur.toFixed(2)}s（${(chars / Math.max(dur, 0.01)).toFixed(1)} 字/秒）${note}`);
  }
  if (rerolled.length) log(`※ 長さが不自然で引き直したブロック: ${[...new Set(rerolled)].join(', ')}`);
  opt.onProgress?.(targets.length, targets.length, '完了');

  // 実測が入ったので、重なり・尺はみ出しをここで見ておく（GUI の警告と同じ判定）
  const after = readNarration(projectDir);
  const cps = persona?.narration.charsPerSecMeasured ?? 11;
  const findings = after ? checkNarration(after, {estimate: (s) => [...s.text].length / cps}) : [];
  for (const f of findings) log(`  ! ${f}`);
  log(`音声生成 完了: ${made.length} 本 / ${totalChars} 文字`);
  return {made, skipped, chars: totalChars, voice, modelId: env.modelId};
};
