// 裏で走らせた claude（エージェント）の「いま何をしているか」を進捗に直す。純粋（プロセスも DOM も触らない）。
//
// 以前は「見せた画像を Read した回数」だけを進捗にしていたので、画を見ずに考えて書く工程（ナレーション原稿など）
// では 0/N のまま何分も止まって見えた。ここでは起動・思考・ツール呼び出し・出力・書き出しを全部数え、
// 数えられる作業（画の確認）があるときだけ確定的な進捗（done/total）にし、それ以外は「動いている」ことと
// 経過時間・ツール回数・出力文字数を文で出す（total=0 → GUI は流れる帯で表示する）。

/** claude の stream-json から拾う出来事（core/agent.ts が流す） */
export type AgentEvent =
  | {kind: 'init'; model?: string}
  | {kind: 'tool'; name: string; input: Record<string, unknown>}
  | {kind: 'tool_result'}
  | {kind: 'text'; text: string}
  | {kind: 'thinking'}
  | {kind: 'heartbeat'; elapsedSec: number};

export type AgentStats = {
  /** init 行を受け取った＝モデルが動き出した */
  started: boolean;
  model?: string;
  elapsedSec: number;
  /** 最後に「出来事」（heartbeat 以外）があった時点の経過秒 */
  lastEventSec: number;
  tools: number;
  reads: number;
  texts: number;
  outputChars: number;
  lastTool?: string;
  lastTarget?: string;
  /** StructuredOutput（最終結果の書き出し）に入った */
  writing: boolean;
  /** 見せた画像のうち Read した数 */
  watched: {done: number; total: number; last?: string};
};

/** onEvent が返す「何が起きたか」（ログに出すかどうかの判断に使う） */
export type AgentStep = 'init' | 'watched' | 'tool' | 'text' | 'writing' | 'heartbeat' | 'none';

export const baseName = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? '';

/** ツール呼び出しの要点（ログ 1 行に入る長さ） */
export const shortTarget = (name: string, input: Record<string, unknown>): string => {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  if (name === 'Read' || name === 'Write' || name === 'Edit') return baseName(s(input.file_path));
  if (name === 'Glob' || name === 'Grep') return s(input.pattern).slice(0, 40);
  if (name === 'WebSearch') return `「${s(input.query).slice(0, 40)}」`;
  if (name === 'WebFetch') return s(input.url).replace(/^https?:\/\//, '').slice(0, 44);
  if (name === 'StructuredOutput') return '';
  const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
  return (first ?? '').slice(0, 40);
};

export const fmtElapsed = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return s >= 60 ? `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒` : `${s}秒`;
};

export const createAgentTracker = (watch: string[] = [], now: () => number = () => Date.now()) => {
  const remain = new Set(watch.map(baseName).filter(Boolean));
  const t0 = now();
  const stats: AgentStats = {started: false, elapsedSec: 0, lastEventSec: 0, tools: 0, reads: 0, texts: 0, outputChars: 0, writing: false, watched: {done: 0, total: remain.size}};
  const touch = () => {
    stats.elapsedSec = Math.round((now() - t0) / 1000);
    stats.lastEventSec = stats.elapsedSec;
  };
  const onEvent = (e: AgentEvent): AgentStep => {
    if (e.kind === 'heartbeat') {
      stats.elapsedSec = Math.max(stats.elapsedSec, Math.round(e.elapsedSec));
      return 'heartbeat';
    }
    touch();
    if (e.kind === 'init') {
      stats.started = true;
      stats.model = e.model;
      return 'init';
    }
    if (e.kind === 'text') {
      stats.started = true;
      stats.texts++;
      stats.outputChars += e.text.length;
      return 'text';
    }
    if (e.kind === 'thinking') {
      stats.started = true;
      stats.texts++;
      return 'text';
    }
    if (e.kind === 'tool_result') return 'none';
    // tool
    stats.started = true;
    stats.tools++;
    stats.lastTool = e.name;
    stats.lastTarget = shortTarget(e.name, e.input) || undefined;
    if (e.name === 'StructuredOutput') {
      stats.writing = true;
      return 'writing';
    }
    if (e.name === 'Read') {
      stats.reads++;
      const n = baseName(String((e.input as {file_path?: string}).file_path ?? ''));
      if (remain.delete(n)) {
        stats.watched.done++;
        stats.watched.last = n;
        return 'watched';
      }
    }
    return 'tool';
  };
  return {stats, onEvent};
};

export type ProgressLabels = {
  /** 何も数えられないとき（既定「AI が考えています」） */
  thinking?: string;
  /** 見せた画像を読んでいるとき（既定「画を確認中」） */
  reading?: string;
  /** 最終結果を書き出しているとき（既定「結果を書き出しています」） */
  writing?: string;
};

export type ProgressView = {done: number; total: number; phase: string};

/** 稼働状況を短い文にする（ログ・phase の末尾に付ける） */
export const activitySummary = (st: AgentStats): string =>
  [fmtElapsed(st.elapsedSec), st.tools ? `ツール ${st.tools} 回` : '', st.outputChars ? `出力 ${st.outputChars} 文字` : ''].filter(Boolean).join('・');

/**
 * 進捗表示に落とす。total=0 は「数えられないが動いている」の意味で、GUI は流れる帯にする。
 * 画の確認が始まったら done/total を出し、書き出しに入ったら満タンにする。
 */
export const progressView = (st: AgentStats, labels: ProgressLabels = {}): ProgressView => {
  const w = st.watched;
  const el = fmtElapsed(st.elapsedSec);
  if (st.writing) return {done: w.total, total: w.total, phase: `${labels.writing ?? '結果を書き出しています'}（${el}）`};
  if (w.total > 0 && w.done > 0) return {done: w.done, total: w.total, phase: `${labels.reading ?? '画を確認中'} ${w.done}/${w.total}（${w.last ?? ''}）・${el}`};
  if (!st.started) return {done: 0, total: 0, phase: `claude を起動しています（${el}）`};
  return {done: 0, total: 0, phase: `${labels.thinking ?? 'AI が考えています'}（${activitySummary(st)}）`};
};
