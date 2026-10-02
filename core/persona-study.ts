// 人格（persona）を分析済みの動画から作る。ファイル・Smartgram MCP・claude を触る側。判断は shared/persona-study.ts。
//
//   fetchInstagramStudyPosts … Smartgram MCP の get_user_posts で、指定ユーザーの最新の動画 N 本（直リンク・キャプション）を取る
//   importStudyVideo          … 動画を <設定の置き場>/persona-studies/<user>/<code>/ に落として、参考動画と同じ形（reference.json）で置く
//   generatePersona           … 取り込み → 1 本ずつ analyzeReference（「バズ動画の型を写す」と同じ分析）→
//                               案件の参考動画の分析と合わせて claude に人格を言語化させる → personas.json に保存
//
// 動画は分析にだけ使う（人格に入るのは言葉の癖・構成・型だけ）。置き場はリポジトリの外（~/.reel-studio/）。
// 鍵は argv にもログにも出さない（core/instagram-mcp.ts と同じ方針）。
import fs from 'node:fs';
import path from 'node:path';
import {studioConfig} from '../studio.config';
import {settingsDir} from './settings';
import {instagramMcpEnv, type InstagramMcpEnv} from './instagram-mcp';
import {InstagramMcpError, mcpInitialize, mcpToolJson} from '../shared/instagram-mcp';
import {analyzeReference, fetchReferenceToInbox, importReferenceVideo, readReference} from './reference';
import {runAgent, type AgentRun} from './agent';
import {agentProgress} from './ai';
import {listProjects, readBrief, resolveProjectDirStrict} from './project';
import {readJsonLoose, writeJsonAtomic} from './json-io';
import {savePersonas} from './personas-store';
import {findPersona, listPersonas, type Persona} from '../shared/personas';
import {isReferenceAnalyzed} from '../shared/reference';
import {
  buildPersonaPrompt,
  describePersonaDraft,
  MAX_STUDY_VIDEOS,
  normalizeInstagramUser,
  PERSONA_DRAFT_SCHEMA,
  personaFromDraft,
  PersonaDraftSchema,
  PersonaStudySchema,
  pickInstagramPosts,
  postsFetchCount,
  selectStudyPosts,
  studyFolderName,
  studyFromPost,
  usableSources,
  type InstagramPost,
  type PersonaDraft,
  type PersonaSource,
  type PersonaStudy,
} from '../shared/persona-study';

// ───────────────────────── 置き場 ─────────────────────────

/** 分析した動画の置き場（<設定の置き場>/persona-studies/）。リポジトリの外 */
export const personaStudiesDir = (): string => path.join(settingsDir(), 'persona-studies');
export const studyUserDir = (target: string): string => path.join(personaStudiesDir(), target.replace(/[^A-Za-z0-9._]/g, '_'));
/** 1 本ぶんのフォルダ。中身は案件と同じ形（reference.json と .studio/reference/）なので analyzeReference がそのまま使える */
export const studyDir = (target: string, code: string): string => path.join(studyUserDir(target), studyFolderName(code));
const studyFile = (dir: string): string => path.join(dir, 'study.json');

export const readStudy = (dir: string): PersonaStudy | null => {
  const f = studyFile(dir);
  if (!fs.existsSync(f)) return null;
  try {
    const r = PersonaStudySchema.safeParse(readJsonLoose(f));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
};

export type StudyEntry = {dir: string; study: PersonaStudy; analyzed: boolean};

/** あるユーザーについて手元にある動画（新しい順） */
export const listStudies = (target: string): StudyEntry[] => {
  const root = studyUserDir(target);
  if (!fs.existsSync(root)) return [];
  const out: StudyEntry[] = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const study = readStudy(dir);
    if (!study) continue;
    out.push({dir, study, analyzed: isReferenceAnalyzed(readReference(dir))});
  }
  return out.sort((a, b) => (a.study.takenAt < b.study.takenAt ? 1 : -1));
};

// ───────────────────────── Smartgram MCP：投稿一覧 ─────────────────────────

type Account = {username?: string; isActive?: boolean};

/** MCP ツールの username 引数に渡す登録済みアカウント。設定で固定されていなければ有効なものを選ぶ */
const resolveExecutor = async (env: InstagramMcpEnv, signal?: AbortSignal): Promise<string> => {
  if (env.account) return env.account;
  const raw = await mcpToolJson<{accounts?: Account[]}>(env, 'list_instagram_accounts', {}, {signal, id: 2});
  const accounts = (raw.accounts ?? []).filter((a) => typeof a.username === 'string' && a.username);
  const pick = accounts.find((a) => a.isActive) ?? accounts[0];
  if (!pick?.username) throw new InstagramMcpError('Smartgram に登録済みの Instagram アカウントがありません（Smartgram のダッシュボードでアカウントを登録してください）');
  return pick.username;
};

export type FetchPostsResult = {
  /** 選んだ動画（新しい順・count 本まで） */
  posts: InstagramPost[];
  /** 取ってきた投稿の総数（写真も含む） */
  fetched: number;
  /** ツールを実行した登録アカウント */
  executor: string;
  /** API の残量の水準（取れなければ null） */
  usage: {level: string; count?: number; limit?: number} | null;
};

/**
 * 指定ユーザーの最新の動画を取る。get_user_posts は動画の直リンク（videoUrl）とキャプションを一緒に返すので、
 * 1 本ずつ download_reel_video（HikerAPI 1 トークン）を叩く必要は無い。
 * 直リンクは数時間で失効するので、受け取ったらすぐ落とすこと（importStudyVideo）。
 */
export const fetchInstagramStudyPosts = async (env: InstagramMcpEnv, target: string, count: number, opt: {signal?: AbortSignal; onLine?: (l: string) => void} = {}): Promise<FetchPostsResult> => {
  const log = opt.onLine ?? (() => {});
  await mcpInitialize(env, {signal: opt.signal});
  const executor = await resolveExecutor(env, opt.signal);
  // 1 時間あたりの上限（200 回）がある。danger なら待ってもらう。残量が取れなくても本体は進める
  let usage: FetchPostsResult['usage'] = null;
  try {
    const u = await mcpToolJson<{level?: string; status?: string; count?: number; limit?: number; used?: number}>(env, 'get_api_usage', {username: executor}, {signal: opt.signal, id: 3});
    usage = {level: String(u.level ?? u.status ?? '').toLowerCase(), count: u.count ?? u.used, limit: u.limit};
  } catch {
    usage = null;
  }
  if (usage?.level === 'danger') throw new InstagramMcpError(`Smartgram の API 使用量が上限に近い（${usage.count ?? '?'}/${usage.limit ?? 200} 回/時）。しばらく時間を空けてから実行してください`);
  if (usage?.level === 'warning') log(`! Smartgram の API 使用量が多め（${usage.count ?? '?'}/${usage.limit ?? 200} 回/時）。件数を絞ると安全です`);
  const want = postsFetchCount(count);
  log(`Instagram @${target} の投稿を取得中（最新 ${want} 件から動画 ${count} 本を選ぶ・実行アカウント @${executor}）`);
  const raw = await mcpToolJson<unknown>(env, 'get_user_posts', {username: executor, target, count: want}, {signal: opt.signal, id: 4});
  const all = pickInstagramPosts(raw);
  if (!all.length) throw new InstagramMcpError(`@${target} の投稿が取れませんでした（非公開アカウントか、ユーザー名の誤りか、投稿が無い）`);
  const posts = selectStudyPosts(all, count);
  if (!posts.length) throw new InstagramMcpError(`@${target} の最新 ${all.length} 件に動画がありませんでした`);
  if (posts.length < count) log(`! 最新 ${all.length} 件のうち動画は ${posts.length} 本でした（${count} 本に届きません）`);
  return {posts, fetched: all.length, executor, usage};
};

// ───────────────────────── 取り込み ─────────────────────────

/**
 * 動画 1 本を落として、参考動画と同じ形で置く。すでに分析済みなら落とさない（force で取り直す）。
 * 返り値の analyzed は「分析まで済んでいて再利用できる」か
 */
export const importStudyVideo = async (target: string, post: InstagramPost, opt: {force?: boolean; signal?: AbortSignal; onLine?: (l: string) => void} = {}): Promise<{dir: string; study: PersonaStudy; analyzed: boolean}> => {
  const log = opt.onLine ?? (() => {});
  const dir = studyDir(target, post.code);
  const existing = readStudy(dir);
  const ref = readReference(dir);
  if (existing && !opt.force && isReferenceAnalyzed(ref)) {
    // キャプションやいいね数は新しいものに更新しておく（分析は使い回す）
    const study = studyFromPost(target, post, existing.savedAt);
    writeJsonAtomic(studyFile(dir), study);
    log(`  ${post.code}: 分析済みを再利用`);
    return {dir, study, analyzed: true};
  }
  if (!post.videoUrl) throw new Error(`${post.code} は動画ではありません`);
  fs.mkdirSync(dir, {recursive: true});
  const name = `@${target}_${post.code}.mp4`;
  log(`  ${post.code}: 動画をダウンロード中（${post.takenAt.slice(0, 10) || '日付不明'}・いいね ${post.likeCount}）`);
  const tmp = await fetchReferenceToInbox(dir, post.videoUrl, name, opt.signal);
  await importReferenceVideo(dir, tmp, {originalName: name, move: true, sourceUrl: post.url});
  const study = studyFromPost(target, post);
  writeJsonAtomic(studyFile(dir), study);
  return {dir, study, analyzed: false};
};

// ───────────────────────── 人格を作る ─────────────────────────

export type GeneratePersonaOptions = {
  /** 新しい人格の id（英小文字で始まる英数字とハイフン）。既にあるときは overwrite が無いと止まる */
  id: string;
  /** 表示名。無ければ AI が付ける */
  label?: string;
  /** Instagram から動画を取って分析する */
  instagram?: {target: string; count?: number};
  /** 分析済みの参考動画を持ってくる案件（slug）。'all' で分析済みの全案件 */
  projects?: string[] | 'all';
  /** 出発点にする既存の人格（ボイス・話速を引き継ぐ） */
  base?: string;
  /** 利用者からの補足（「関西弁で」など） */
  hint?: string;
  /** 同じ id の人格があれば置き換える */
  overwrite?: boolean;
  /** 分析済みの動画も分析し直す */
  force?: boolean;
  model?: string;
  onLine?: (l: string) => void;
  onProgress?: (done: number, total: number, phase: string) => void;
  signal?: AbortSignal;
};

export type GeneratePersonaResult = {
  persona: Persona;
  draft: PersonaDraft;
  /** 材料にした動画の数（Instagram / 案件） */
  sources: {instagram: number; projects: number};
  /** 新しく分析した動画の数（再利用は含まない） */
  analyzed: number;
  costUsd: number;
  /** 既存の人格を置き換えたか */
  replaced: boolean;
  lines: string[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** 分析済みの参考動画がある案件（画面の候補・'all' の解決に使う） */
export const projectsWithAnalyzedReference = (): {slug: string; dir: string; shopName: string}[] =>
  listProjects()
    .filter((p) => p.has.reference)
    .map((p) => ({slug: p.slug, dir: p.dir, shopName: readBrief(p.dir)?.shop.name ?? ''}))
    .filter((p) => isReferenceAnalyzed(readReference(p.dir)));

/**
 * 人格を作る。Instagram の動画と案件の参考動画のどちらか（両方でも）が要る。
 * 動画の分析は 1 本ずつ直列（ffmpeg と claude を同時に何本も走らせない）。E があれば保存しない。
 */
export async function generatePersona(opt: GeneratePersonaOptions): Promise<GeneratePersonaResult> {
  const log = opt.onLine ?? (() => {});
  const model = opt.model ?? studioConfig.agent.model;
  const id = opt.id.trim();
  const exists = findPersona(id);
  if (exists && !opt.overwrite) throw new Error(`人格「${id}」は既にあります。別の id にするか、置き換える指定（overwrite）を付けてください`);
  const base = opt.base ? findPersona(opt.base) : undefined;
  if (opt.base && !base) throw new Error(`出発点にする人格がありません: ${opt.base}`);

  // 1. 案件の参考動画（分析済みのものだけ）
  const sources: PersonaSource[] = [];
  const wanted = opt.projects === 'all' ? projectsWithAnalyzedReference().map((p) => p.slug) : (opt.projects ?? []);
  for (const slug of wanted) {
    const dir = resolveProjectDirStrict(slug);
    const ref = readReference(dir);
    if (!ref || !isReferenceAnalyzed(ref)) {
      log(`! 案件「${slug}」には分析済みの参考動画がありません（飛ばします）`);
      continue;
    }
    sources.push({reference: ref, slug, shopName: readBrief(dir)?.shop.name});
  }
  if (wanted.length) log(`案件の参考動画: ${sources.length} 本`);

  // 2. Instagram の最新の動画
  let analyzedCount = 0;
  let costUsd = 0;
  let target: string | undefined;
  const ig = opt.instagram;
  if (ig) {
    target = normalizeInstagramUser(ig.target) ?? undefined;
    if (!target) throw new Error(`Instagram のユーザー名として読めません: ${ig.target}（@ 無しの英数字・ピリオド・アンダースコア）`);
    const env = instagramMcpEnv();
    if (!env) throw new Error('Instagram から動画を取るには、Settings の「Instagram の情報取得」に Smartgram の MCP 用 API キーが要ります');
    const count = Math.max(1, Math.min(MAX_STUDY_VIDEOS, Math.floor(ig.count ?? 6)));
    opt.onProgress?.(0, count + 1, `Instagram @${target} の投稿を取得しています`);
    const fetched = await fetchInstagramStudyPosts(env, target, count, {signal: opt.signal, onLine: log});
    log(`動画 ${fetched.posts.length} 本を選びました（${fetched.fetched} 件中）`);
    const total = fetched.posts.length + 1;
    for (let i = 0; i < fetched.posts.length; i++) {
      opt.signal?.throwIfAborted();
      const post = fetched.posts[i];
      const k = i + 1;
      opt.onProgress?.(i, total, `動画 ${k}/${fetched.posts.length} を取り込んでいます`);
      const got = await importStudyVideo(target, post, {force: opt.force, signal: opt.signal, onLine: log});
      let ref = readReference(got.dir);
      if (!got.analyzed) {
        log(`動画 ${k}/${fetched.posts.length}: 型を分析します（${post.code}）`);
        ref = await analyzeReference(got.dir, {
          model,
          onLine: (l) => log(`  ${l}`),
          onProgress: (done, tot, phase) => opt.onProgress?.(r2(i + (tot > 0 ? Math.min(1, done / tot) : 0)), total, `動画 ${k}/${fetched.posts.length}: ${phase}`),
          signal: opt.signal,
        });
        analyzedCount++;
        costUsd += ref.costUsd;
      }
      if (ref && isReferenceAnalyzed(ref)) sources.push({reference: ref, study: got.study});
    }
  }

  const usable = usableSources(sources);
  if (!usable.length) throw new Error('人格の材料になる分析済みの動画がありません（Instagram のユーザー名を入れるか、Brief の「バズ動画の型を写す」で分析した案件を選んでください）');

  // 3. 言語化
  const igCount = usable.filter((s) => s.study).length;
  const prCount = usable.length - igCount;
  opt.onProgress?.(0, 0, `人格を言語化しています（動画 ${usable.length} 本）`);
  log(`人格を言語化: 動画 ${usable.length} 本（Instagram ${igCount} / 案件 ${prCount}・model=${model}）`);
  const cwd = personaStudiesDir();
  fs.mkdirSync(cwd, {recursive: true});
  const prompt = buildPersonaPrompt({target, sources: usable, base, hint: opt.hint});
  const {onEvent} = agentProgress({onProgress: opt.onProgress, log, labels: {thinking: '言葉の癖と型を言語化しています', writing: '人格を書き出しています'}});
  const run: AgentRun<unknown> = await runAgent({cwd, prompt, schema: PERSONA_DRAFT_SCHEMA, model, timeoutMs: studioConfig.agent.timeoutMs, onLine: log, onEvent, signal: opt.signal});
  costUsd += run.costUsd;
  const parsed = PersonaDraftSchema.safeParse(run.data);
  if (!parsed.success) throw new Error(`人格の返答が読めませんでした: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  const draft = parsed.data;
  const label = opt.label?.trim() || (target && !draft.label.trim() ? `@${target} 風` : undefined);
  const persona = personaFromDraftSafe(id, draft, {base, label});

  // 4. 保存（id が同じものがあれば置き換え）
  const list = listPersonas();
  const replaced = !!exists;
  savePersonas(replaced ? list.map((p) => (p.id === id ? persona : p)) : [...list, persona]);
  const lines = describePersonaDraft(persona, draft);
  log(`人格「${persona.label}」（${persona.id}）を${replaced ? '置き換えました' : '追加しました'}（$${costUsd.toFixed(3)}）`);
  for (const l of lines) log(`  ${l}`);
  return {persona, draft, sources: {instagram: igCount, projects: prCount}, analyzed: analyzedCount, costUsd, replaced, lines};
}

/** personaFromDraft の例外を、どこを直せばよいか分かる文にする */
const personaFromDraftSafe = (id: string, draft: PersonaDraft, opt: {base?: Persona; label?: string}): Persona => {
  try {
    return personaFromDraft(id, draft, opt);
  } catch (e) {
    throw new Error(`人格の形にできませんでした: ${e instanceof Error ? e.message : String(e)}`);
  }
};
