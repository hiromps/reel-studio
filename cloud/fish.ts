// Fish Audio（音声生成）をクラウドから直接叩く部分。
//
// core/tts.ts と同じ API を呼ぶが、あちらは案件フォルダに wav を書く前提で fs・ffprobe・
// 設定ファイルに依存している。クラウドで必要なのは「ボイス一覧」と「試聴」の 2 つだけなので、
// HTTP の部分だけをここに持つ（鍵は Vercel の環境変数 FISH_API_KEY）。
// 叩き方（エンドポイント・developer-id・body）は core/tts.ts と揃えること。
import type {Persona} from '../shared/personas';

const ENDPOINT = 'https://api.fish.audio/v1/tts';
/** fish-audio-sdk が既定で送っている値 */
const DEVELOPER_ID = '6322d9df15d044e7b928de27c863480f';
const DEFAULT_MODEL = 's2.1-pro-free';

export const NO_FISH_KEY = 'Fish Audio の API キーが未設定です（Vercel の環境変数 FISH_API_KEY）';

const literal = (v: unknown): string | null => (typeof v === 'string' && v.trim() && !v.startsWith('${') ? v.trim() : null);

export type FishEnv = {apiKey: string; modelId: string};

export const fishEnv = (): FishEnv | null => {
  const apiKey = literal(process.env.FISH_API_KEY);
  return apiKey ? {apiKey, modelId: literal(process.env.FISH_MODEL_ID) ?? DEFAULT_MODEL} : null;
};

const headers = (apiKey: string) => ({Authorization: `Bearer ${apiKey}`, 'developer-id': DEVELOPER_ID});

/** 鍵が通るか（Settings の接続テスト）。鍵は応答にもログにも出さない */
export const probeFishKey = async (apiKey: string, opt: {signal?: AbortSignal} = {}): Promise<{ok: boolean; status?: number; message: string}> => {
  try {
    const res = await fetch('https://api.fish.audio/model?self=true&page_size=1', {headers: headers(apiKey), signal: opt.signal});
    if (res.status === 401 || res.status === 403) return {ok: false, status: res.status, message: `鍵が拒否されました（HTTP ${res.status}）。Fish Audio の API キーを確認してください`};
    if (!res.ok) return {ok: false, status: res.status, message: `Fish Audio が HTTP ${res.status} を返しました`};
    const data = (await res.json()) as {total?: number; items?: unknown[]};
    const n = typeof data.total === 'number' ? data.total : (data.items?.length ?? 0);
    return {ok: true, status: res.status, message: `接続できました（自分の登録モデル ${n} 件）`};
  } catch (e) {
    return {ok: false, message: `接続できません: ${e instanceof Error ? e.message : String(e)}`};
  }
};

export type Voice = {id: string; title: string; source: 'own' | 'persona' | 'extra'; personas: string[]; languages?: string[]; state?: string};
type ModelListItem = {_id?: string; id?: string; title?: string; state?: string; languages?: string[]};

/**
 * 選べるボイス。人格の既定ボイス（他人の公開モデルのことがあり self には出ない）＋
 * 追加ボイス＋自分の登録モデル。鍵が無ければ人格のボイスだけ返す（画面を空にしない）。
 */
export const listVoices = async (personas: Persona[], extra: {id: string; title: string}[], opt: {signal?: AbortSignal} = {}): Promise<{voices: Voice[]; apiError?: string}> => {
  const byId = new Map<string, Voice>();
  for (const p of personas) {
    if (!p.narration.voiceId) continue;
    const cur = byId.get(p.narration.voiceId);
    if (cur) cur.personas.push(p.id);
    else byId.set(p.narration.voiceId, {id: p.narration.voiceId, title: p.narration.voiceTitle, source: 'persona', personas: [p.id]});
  }
  for (const v of extra) {
    if (!v.id) continue;
    const cur = byId.get(v.id);
    byId.set(v.id, {id: v.id, title: v.title || cur?.title || v.id, source: cur?.source ?? 'extra', personas: cur?.personas ?? []});
  }
  const named = new Set(extra.map((v) => v.id));

  const env = fishEnv();
  let apiError: string | undefined;
  if (env) {
    try {
      const res = await fetch('https://api.fish.audio/model?self=true&page_size=100', {headers: headers(env.apiKey), signal: opt.signal});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {items?: ModelListItem[]};
      for (const it of data.items ?? []) {
        const id = it._id ?? it.id;
        if (!id) continue;
        const cur = byId.get(id);
        if (cur) byId.set(id, {...cur, title: named.has(id) ? cur.title : (it.title ?? cur.title), source: 'own', languages: it.languages, state: it.state});
        else byId.set(id, {id, title: it.title ?? id, source: 'own', personas: [], languages: it.languages, state: it.state});
      }
    } catch (e) {
      apiError = e instanceof Error ? e.message : String(e);
    }
  } else {
    apiError = `${NO_FISH_KEY}（人格のボイスだけ出しています）`;
  }
  const order = personas.map((p) => p.id);
  const rank = (v: Voice) => (v.personas.length ? Math.min(...v.personas.map((x) => order.indexOf(x))) : v.source === 'extra' ? 50 : 99);
  return {voices: [...byId.values()].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title, 'ja')), apiError};
};

/** 試聴。1 本だけ作って wav を返す（案件には何も書かない） */
export const synthPreview = async (text: string, opt: {voice: string; speed?: number; latency?: string; signal?: AbortSignal}): Promise<Buffer> => {
  const env = fishEnv();
  if (!env) throw new Error(NO_FISH_KEY);
  const body = text.trim();
  if (!body) throw new Error('読み上げる文が空です');
  if (!opt.voice) throw new Error('ボイスが選ばれていません');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {...headers(env.apiKey), 'Content-Type': 'application/json', model: env.modelId},
    // body の形は core/tts.ts:ttsBody と同じにする（sample_rate は wav では 400 になるので入れない）
    body: JSON.stringify({
      text: body,
      format: 'wav',
      latency: opt.latency ?? 'normal',
      chunk_length: 200,
      normalize: true,
      references: [],
      reference_id: opt.voice,
      prosody: {speed: opt.speed ?? 1, volume: 0},
    }),
    signal: opt.signal ?? AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Fish Audio が HTTP ${res.status} を返しました`);
  return Buffer.from(await res.arrayBuffer());
};
