// config / personas / settings / sfx / tts / アップロード。
//
// PC でしか分からないこと（ffmpeg の有無・claude のバージョン・フォルダの実在・deface）は、
// ワーカーが kv に置いたスナップショットを返す。PC でしかできない操作（フォルダ選択ダイアログ）は
// 501 を返し、画面はクラウドではそのボタンを出さない。
import {Router} from 'express';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {copyLocalMedia, localMediaRoot, requireLocalMedia} from '../../core/local-media';
import {PersonaIdSchema} from '../../shared/schema/brief';
import {BUILTIN_PERSONAS, PersonaSchema, findPersona, listPersonas, setPersonas, type Persona} from '../../shared/personas';
import {agentStatusOf, overlayPendingAgent, AGENT_PROVIDERS, DEFAULT_DEEPSEEK_MODEL, DEFAULT_INSTAGRAM_MCP_URL, SettingsPatchSchema, type AgentProvider, type AgentStatus, type SettingsView} from '../../shared/schema/settings';
import {fetchClaudeModels, fetchDeepseekModels} from '../../shared/agent-models';
import {scriptSkillCatalog} from '../../shared/script-skill';
import {probeInstagramMcp} from '../../shared/instagram-mcp';
import {probeDeepseekKey} from '../../shared/deepseek';
import {safeFontFile} from '../../shared/schema/fonts';
import {SfxSoundSchema, type SfxLibrary} from '../../shared/sfx';
import type {LibraryIndexEntry} from '../../shared/reference';
import {JOB_TYPES} from '../../shared/jobs';
import {normalizeSlug} from '../../shared/project';
import {NarrationLibraryEntrySchema, type NarrationLibraryEntry} from '../../shared/narration-library';
import {NarrationSegmentSchema} from '../../shared/schema';
import {fishEnv, listVoices, probeFishKey, synthPreview} from '../fish';
import {countSubscriptions, publicKey, pushAvailable, removeSubscription, saveSubscription, sendToAll} from '../push';
import {addJob, findAsset, kvGet, kvSet, listJobs, listProjects, putAsset, replacePersonas} from '../store';
import {WORKER_ONLINE_MS, type WorkerStatus} from '../worker-status';
import {defaultEmotionTags, EmotionTagsSchema} from '../../shared/emotion-tags';

export const miscRouter = Router();
miscRouter.get('/emotion-tags', async (_req, res) => {
  const view = await kvGet<{emotionTags?: unknown}>('settings-view');
  const config = EmotionTagsSchema.safeParse(view?.emotionTags);
  res.setHeader('Cache-Control', 'no-store');
  res.json(config.success ? config.data : defaultEmotionTags());
});

miscRouter.use(['/narration-library', '/sfx/file', '/tts/preview'], (_req, res, next) => {
  if (process.env.VERCEL) return res.status(409).json({error: '音声ファイルは PC に保存されています。PC の Reel Studio で操作してください'});
  next();
});

const narrationLibrary = async (): Promise<NarrationLibraryEntry[]> => (await kvGet<{entries: NarrationLibraryEntry[]}>('narration-library'))?.entries ?? [];

miscRouter.get('/narration-library', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json({entries: (await narrationLibrary()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))});
});

miscRouter.post('/narration-library', async (req, res) => {
  const project = typeof req.body?.project === 'string' ? normalizeSlug(req.body.project) : '';
  const segment = NarrationSegmentSchema.safeParse(req.body?.segment);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!project || !segment.success || !/^[a-zA-Z0-9_-]+$/.test(segment.data.id) || !segment.data.durSec || (segment.data as {needsTts?: boolean}).needsTts || !segment.data.text.trim() || !title || title.length > 80) return res.status(400).json({error: '生成済みの音声と保存名を指定してください'});
  const source = await findAsset(project, 'narration', 'full', `${segment.data.id}.wav`);
  if (!source) return res.status(409).json({error: '音声のローカル参照がありません。PC の Reel Studio で保存してください'});
  const sourceFile = requireLocalMedia(source.url);
  const entry = NarrationLibraryEntrySchema.parse({
    id: randomUUID(), title, text: segment.data.text, voice: String(req.body?.narration?.voice ?? ''),
    voiceTitle: req.body?.narration?.voiceTitle, speed: req.body?.narration?.speed,
    latency: req.body?.narration?.latency, durSec: segment.data.durSec, trimSec: segment.data.trimSec, createdAt: new Date().toISOString(),
  });
  const relPath = `${entry.id}.wav`;
  const file = path.join(localMediaRoot(), '_global', 'full', 'narration', relPath);
  copyLocalMedia(sourceFile, file);
  await putAsset({slug: '_global', kind: 'narration', mode: 'full', relPath, url: file, bytes: fs.statSync(file).size, hash: source.hash, contentType: 'audio/wav'});
  await kvSet('narration-library', {entries: [entry, ...await narrationLibrary()]});
  res.json({entry});
});

miscRouter.get('/narration-library/:id/audio', async (req, res) => {
  const entry = (await narrationLibrary()).find((x) => x.id === req.params.id);
  if (!entry) return res.status(404).json({error: '音声が見つかりません'});
  const asset = await findAsset('_global', 'narration', 'full', `${entry.id}.wav`);
  if (!asset) return res.status(404).json({error: '音声ファイルが見つかりません'});
  res.sendFile(requireLocalMedia(asset.url), {headers: {'Cache-Control': 'private, no-cache'}, acceptRanges: true});
});

miscRouter.post('/narration-library/:id/use', async (req, res) => {
  const entry = (await narrationLibrary()).find((x) => x.id === req.params.id);
  const project = typeof req.body?.project === 'string' ? normalizeSlug(req.body.project) : '';
  const segmentId = req.body?.segmentId;
  if (!entry) return res.status(404).json({error: '保存した音声が見つかりません'});
  if (!project || typeof segmentId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(segmentId)) return res.status(400).json({error: '案件と音声 ID が必要です'});
  const asset = await findAsset('_global', 'narration', 'full', `${entry.id}.wav`);
  if (!asset) return res.status(404).json({error: '保存した音声ファイルが見つかりません'});
  await putAsset({slug: project, kind: 'narration', mode: 'full', relPath: `${segmentId}.wav`, url: asset.url, bytes: asset.bytes, hash: asset.hash, contentType: 'audio/wav'});
  res.json({entry});
});

miscRouter.delete('/narration-library/:id', async (req, res) => {
  const entries = await narrationLibrary();
  if (!entries.some((x) => x.id === req.params.id)) return res.json({removed: false});
  await kvSet('narration-library', {entries: entries.filter((x) => x.id !== req.params.id)});
  res.json({removed: true});
});

// ───────────────────────── config ─────────────────────────

const agentStatusOfView = (s: SettingsView | null, claude: boolean): AgentStatus => {
  const a = s?.settings.agent;
  const provider = a?.provider ?? 'claude';
  const model = provider === 'deepseek' ? (a?.deepseekModel ?? DEFAULT_DEEPSEEK_MODEL) : provider === 'codex' ? (a?.codexModel ?? '') : (a?.model ?? 'opus');
  return agentStatusOf(provider, model, {claude, codex: !!s?.codex?.available, codexLoggedIn: s?.codex?.loggedIn, deepseekKey: !!a?.deepseekApiKey?.present});
};

miscRouter.get('/config', async (_req, res) => {
  const [w, s] = [await kvGet<WorkerStatus>('worker'), await settingsViewCloud()];
  const online = !!w && Date.now() - new Date(w.lastSeen).getTime() < WORKER_ONLINE_MS;
  res.json({
    // クラウドでは案件の実体は PC にある。画面には「PC 側のパス」をそのまま見せる
    dataRoot: s?.paths.dataRoot.value ?? '',
    workDir: s?.paths.workDir.value ?? '',
    uploadsRoot: s?.paths.uploadsRoot.value ?? '',
    outputsDir: s?.paths.outputsDir.value ?? '',
    sfxDir: s?.paths.sfxDir.value ?? '',
    templateDir: s?.paths.templateDir ?? '',
    settingsDir: s?.dir ?? '',
    settingsProblem: s?.problem ?? null,
    personasProblem: null,
    personas: listPersonas().length,
    port: 0,
    jobTypes: [...JOB_TYPES],
    // クラウドは常に最新のコードで動く（サーバーが古い、が起きない）
    stale: false,
    tts: !!fishEnv(),
    claude: w?.claude ?? false,
    // AI の接続先は PC の設定（ワーカーが送ってきた見え方）が正。古いワーカーの見え方には provider が無い＝Claude
    agent: agentStatusOfView(s, w?.claude ?? false),
    // 裏取りは PC の claude が走らせるので、鍵の有無も PC の設定（ワーカーが送ってきた見え方）で判断する
    instagramMcp: !!s?.settings.instagram?.mcpKey?.present,
    // PC で取り込んだ自前フォント（Timeline のフォント選択が使う）。実体は PC にある
    fonts: s?.fonts ?? [],
    scriptSkills: scriptSkillCatalog(s.settings),
    telopFont: s?.settings.telop?.font ?? null,
    startedAt: w?.lastSeen ?? new Date().toISOString(),
    uploadsFolders: w?.uploadsFolders ?? [],
    // ── ここからクラウド版だけが返すもの（画面がローカル専用 UI を隠すのに使う） ──
    mode: 'cloud' as const,
    renderDevice: online ? w?.renderDevice ?? null : null,
    localRenderProjects: online ? w?.localRenderProjects ?? [] : [],
    worker: {online, lastSeen: w?.lastSeen ?? null, node: w?.node ?? null, ffmpeg: w?.ffmpeg ?? null, ffprobe: w?.ffprobe ?? null, host: w?.host ?? null},
  });
});

/** フォルダ選択ダイアログは PC の機能。クラウドからは開けない */
miscRouter.post('/pick-folder', (_req, res) => {
  res.status(501).json({error: 'フォルダの選択は PC 上の Reel Studio で行ってください（パスは手で入力できます）'});
});

// ───────────────────────── 人格 ─────────────────────────

const personaView = async () => ({personas: listPersonas(), file: '（クラウド）', builtinIds: BUILTIN_PERSONAS.map((p) => p.id), problem: null});

const persist = async (list: Persona[]) => {
  setPersonas(list);
  await replacePersonas(list.map((p) => ({id: p.id, data: p})));
  // PC 側の ~/.reel-studio/personas.json にも反映させる（AI のプロンプトがこれを読む）
  await kvSet('personas-rev', {rev: Date.now()});
};

miscRouter.get('/personas', async (_req, res) => res.json(await personaView()));

miscRouter.post('/personas', async (req, res) => {
  const {from, id, label, persona} = req.body ?? {};
  let next: Persona;
  if (typeof from === 'string') {
    const src = findPersona(from);
    if (!src) return res.status(404).json({error: `複製元の人格がありません: ${from}`});
    const pid = PersonaIdSchema.safeParse(id);
    if (!pid.success) return res.status(400).json({error: pid.error.issues[0]?.message ?? 'id が不正'});
    next = {...src, id: pid.data, label: typeof label === 'string' && label.trim() ? label.trim() : `${src.label}（コピー）`};
  } else {
    const parsed = PersonaSchema.safeParse(persona);
    if (!parsed.success) return res.status(400).json({error: '検証に失敗', issues: parsed.error.issues.slice(0, 20)});
    next = parsed.data;
  }
  if (findPersona(next.id)) return res.status(409).json({error: `その id は既にあります: ${next.id}`});
  await persist([...listPersonas(), next]);
  res.json({...(await personaView()), persona: next});
});

miscRouter.put('/personas/:id', async (req, res) => {
  const cur = findPersona(req.params.id);
  if (!cur) return res.status(404).json({error: `人格がありません: ${req.params.id}`});
  const parsed = PersonaSchema.safeParse({...(req.body ?? {}), id: cur.id});
  if (!parsed.success) return res.status(400).json({error: '検証に失敗', issues: parsed.error.issues.slice(0, 20)});
  await persist(listPersonas().map((p) => (p.id === cur.id ? parsed.data : p)));
  res.json({...(await personaView()), persona: parsed.data});
});

miscRouter.delete('/personas/:id', async (req, res) => {
  const cur = findPersona(req.params.id);
  if (!cur) return res.status(404).json({error: `人格がありません: ${req.params.id}`});
  if (listPersonas().length <= 1) return res.status(409).json({error: '最後の 1 件は消せません（先に別の人格を追加してください）'});
  const force = req.query.force === '1' || req.query.force === 'true';
  const using = (await listProjects()).filter((p) => p.persona === cur.id).map((p) => p.slug);
  if (using.length && !force) return res.status(409).json({error: `この人格を使っている案件があります: ${using.join(', ')}`, projects: using});
  await persist(listPersonas().filter((p) => p.id !== cur.id));
  res.json(await personaView());
});

// ───────────────────────── 設定 ─────────────────────────

/** ワーカーが送ってきた見え方に、クラウド側の事実（Fish の鍵）を重ねる */
const settingsViewCloud = async (): Promise<SettingsView> => {
  const s = await kvGet<SettingsView>('settings-view');
  const w = await kvGet<WorkerStatus>('worker');
  const base: SettingsView =
    s ??
    ({
      dir: '（PC 未接続）',
      file: '',
      exists: false,
      problem: 'PC のワーカーがまだ繋がっていません',
      settings: {
        version: 1,
        paths: {},
        tts: {provider: 'fish-audio', modelId: 's2.1-pro-free', voices: [], apiKey: {present: false, masked: '', source: null}},
        agent: {provider: 'claude', deepseekModel: 'deepseek-v4-pro', codexModel: '', deepseekApiKey: {present: false, masked: '', source: null}, claudeCatalogApiKey: {present: false, masked: '', source: null}, model: 'opus', tagBatchSize: 8, tagConcurrency: 3, timeoutMin: 20},
        mosaic: {},
        instagram: {mcpKey: {present: false, masked: '', source: null}},
      } as unknown as SettingsView['settings'],
      paths: {} as SettingsView['paths'],
      fonts: [],
      env: {fishApiKey: false, fishModelId: false, claudeBin: false, agentModel: false, agentProvider: false, deepseekApiKey: false, mosaicPython: false, cloudUrl: false, cloudToken: false, instagramMcpUrl: false, instagramMcpKey: false, instagramAccount: false},
      claude: {bin: '', available: false, source: 'none', version: null},
    } as SettingsView);
  // 台本スキルは同期待ちでも保存済みの内容を返す（旧スナップショットで画面を戻さない）。
  const pending = await kvGet<{patch: Record<string, unknown>}>('settings-patch');
  const pendingSkill = SettingsPatchSchema.shape.scriptSkill.safeParse(pending?.patch.scriptSkill);
  const pendingLibrary = SettingsPatchSchema.shape.scriptSkills.safeParse(pending?.patch.scriptSkills);
  const scriptSkill = pendingSkill.success && pendingSkill.data !== undefined ? pendingSkill.data ?? undefined : base.settings.scriptSkill;
  const scriptSkills = pendingLibrary.success && pendingLibrary.data !== undefined ? pendingLibrary.data : base.settings.scriptSkills;
  // AI の接続先・モデルも同じ。PC が適用するまで旧スナップショットを返すと、保存した直後に選択が元に戻って
  // 「保存できない」ように見える。鍵（*ApiKey）と実行ファイルの場所は PC の事実を正とするので重ねない
  const pendingAgent = overlayPendingAgent(base.settings.agent, pending?.patch.agent);
  const env = fishEnv();
  return {
    ...base,
    ...(pendingAgent.pending ? {pendingAgent: true} : {}),
    // 音声生成の鍵はクラウド側（Vercel の環境変数）を使う。PC の鍵は PC のジョブが使う
    settings: {...base.settings, agent: pendingAgent.agent, scriptSkill, scriptSkills, tts: {...base.settings.tts, apiKey: env ? {present: true, masked: '••••（Vercel）', source: 'env'} : base.settings.tts.apiKey}},
    env: {...base.env, fishApiKey: !!env},
    claude: base.claude.available ? base.claude : {...base.claude, version: w?.claudeVersion ?? base.claude.version, available: !!w?.claude},
  };
};

miscRouter.get('/settings', async (_req, res) => res.json(await settingsViewCloud()));

miscRouter.post('/settings/models', async (req, res) => {
  const provider = req.body?.provider;
  if (!AGENT_PROVIDERS.includes(provider as AgentProvider)) return res.status(400).json({error: '接続先が不正です'});
  const key = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  if ((provider === 'deepseek' || provider === 'claude') && key) {
    try {
      const models = provider === 'deepseek' ? await fetchDeepseekModels(key) : await fetchClaudeModels(key);
      return res.json({provider, models, source: 'provider'});
    }
    catch (e) {return res.status(502).json({error: (e as Error).message});}
  }
  const view = await kvGet<SettingsView>('settings-view');
  const catalog = view?.agentModels?.[provider as AgentProvider];
  if (catalog) return res.json(catalog);
  res.status(503).json({error: 'PC のワーカーからモデル一覧を取得できていません。同期後に更新してください'});
});

/** 変更は PC に届ける（実体は PC の ~/.reel-studio/settings.json）。ワーカーが適用して見え方を返してくる */
miscRouter.put('/settings', async (req, res) => {
  const parsed = SettingsPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({error: '検証に失敗', issues: parsed.error.issues.slice(0, 20)});
  const touchesFolders = parsed.data.dataRoot !== undefined || parsed.data.paths !== undefined;
  if (touchesFolders && (await listJobs(20)).some((j) => j.status === 'queued' || j.status === 'running'))
    return res.status(409).json({error: 'ジョブの実行中はフォルダの設定を変えられません。終わるか中止してから保存してください'});
  const cur = (await kvGet<{rev: number; patch: Record<string, unknown>}>('settings-patch')) ?? {rev: 0, patch: {}};
  await kvSet('settings-patch', {rev: cur.rev + 1, patch: {...cur.patch, ...parsed.data}});
  const view = await settingsViewCloud();
  res.json({...view, problem: view.problem ?? 'PC に反映を依頼しました（次の同期で適用されます）'});
});

/** PC の claude CLI のログイン状態（ワーカーが送ってきた控え。最新は PC 側で確認する） */
miscRouter.get('/settings/claude/auth', async (_req, res) => {
  const view = await kvGet<SettingsView>('settings-view');
  res.json({available: !!view?.claude.available, auth: view?.claude.auth ?? null, command: 'claude auth login', remote: true});
});

/** ログインはブラウザでの承認が要るので、PC の前で行う（クラウドからは開けない） */
miscRouter.post('/settings/claude/login', (_req, res) => {
  res.status(409).json({error: 'ログインは PC で行います。PC の Reel Studio の Settings で「Claude に再接続」を押してください'});
});

/**
 * 接続先を Claude に戻す（クラウド画面から）。PC がログイン済みなら設定の変更を預けて PC に適用させる。
 * 未ログイン・期限切れなら PC での操作を案内する
 */
miscRouter.post('/settings/claude/reconnect', async (req, res) => {
  const view = await kvGet<SettingsView>('settings-view');
  const w = await kvGet<WorkerStatus>('worker');
  const auth = view?.claude.auth ?? null;
  const online = !!w && Date.now() - Date.parse(w.lastSeen) < WORKER_ONLINE_MS;
  if (!view?.claude.available) return res.json({state: 'failed', auth, message: 'PC で claude が見つかりません。PC に Claude Code をインストールしてください'});
  if (auth && !auth.loggedIn) return res.json({state: 'failed', auth, message: `PC の Claude がログインしていません${auth.error ? `（${auth.error}）` : ''}。PC の Reel Studio の Settings で「Claude に再接続」を押してログインしてください`});
  const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
  const cur = (await kvGet<{rev: number; patch: Record<string, unknown>}>('settings-patch')) ?? {rev: 0, patch: {}};
  const agent = {...((cur.patch.agent as Record<string, unknown> | undefined) ?? {}), provider: 'claude', ...(model ? {model} : {})};
  await kvSet('settings-patch', {rev: cur.rev + 1, patch: {...cur.patch, agent}});
  res.json({
    state: 'pending',
    auth,
    message: online ? 'PC に Claude への切り替えを依頼しました（数十秒で反映されます）' : 'PC がオフラインです。PC の Reel Studio が起動すると Claude に切り替わります',
    view: await settingsViewCloud(),
  });
});

miscRouter.post('/settings/test/tts', async (req, res) => {
  const typed = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  const key = typed || fishEnv()?.apiKey || '';
  if (!key) return res.json({ok: false, message: 'API キーが未設定です（Vercel の環境変数 FISH_API_KEY）'});
  res.json({...(await probeFishKey(key, {signal: AbortSignal.timeout(15_000)})), source: typed ? 'input' : 'env'});
});

/**
 * Smartgram の MCP は HTTPS なのでクラウドからも直接叩ける。ただし保存済みの鍵は PC にしか無いので、
 * 入力中の鍵があるときだけ試す（保存済みの鍵での確認は PC 側の Settings で）
 */
miscRouter.post('/settings/test/instagram', async (req, res) => {
  const typedKey = typeof req.body?.mcpKey === 'string' ? req.body.mcpKey.trim() : '';
  const typedUrl = typeof req.body?.mcpUrl === 'string' ? req.body.mcpUrl.trim() : '';
  const url = typedUrl || DEFAULT_INSTAGRAM_MCP_URL;
  if (!typedKey) {
    const s = await kvGet<SettingsView>('settings-view');
    const present = !!s?.settings.instagram?.mcpKey?.present;
    return res.json({ok: present, url, source: present ? 'settings' : null, message: present ? 'PC に鍵が保存されています（鍵そのものでの確認は PC 側の Settings で行ってください）' : 'MCP 用の API キーが未設定です'});
  }
  if (!/^https?:\/\//.test(url)) return res.json({ok: false, message: `MCP サーバーの URL が不正です: ${url}`});
  res.json({...(await probeInstagramMcp({url, apiKey: typedKey}, {signal: AbortSignal.timeout(25_000)})), url, source: 'input'});
});

/** DeepSeek の残高 API はクラウドからも叩ける。保存済みの鍵は PC にしか無いので、入力中の鍵があるときだけ試す */
miscRouter.post('/settings/test/deepseek', async (req, res) => {
  const typed = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  if (!typed) {
    const s = await kvGet<SettingsView>('settings-view');
    const present = !!s?.settings.agent?.deepseekApiKey?.present;
    return res.json({ok: present, source: present ? 'settings' : null, message: present ? 'PC に鍵が保存されています（鍵そのものでの確認は PC 側の Settings で行ってください）' : 'DeepSeek の API キーが未設定です'});
  }
  res.json({...(await probeDeepseekKey(typed, {signal: AbortSignal.timeout(15_000)})), source: 'input'});
});

miscRouter.post('/settings/test/claude', async (_req, res) => {
  const w = await kvGet<WorkerStatus>('worker');
  res.json({
    ok: !!w?.claude,
    bin: w?.claudeBin ?? '',
    version: w?.claudeVersion ?? null,
    message: w?.claude ? `PC で動きました（${w.claudeVersion ?? '?'}）` : 'PC の Claude Code が見つかりません（PC 側の Settings で確認してください）',
  });
});

miscRouter.post('/settings/test/codex', async (_req, res) => {
  const s = await kvGet<SettingsView>('settings-view');
  const codex = s?.codex;
  res.json({ok: !!codex?.available, bin: codex?.bin ?? '', version: codex?.version ?? null, message: codex?.available ? `PC で動きました（${codex.version ?? '?'}）` : 'PC の Codex CLI が見つかりません'});
});

miscRouter.get('/settings/mosaic', async (_req, res) => {
  const w = await kvGet<WorkerStatus>('worker');
  res.json(w?.mosaic ?? {ok: false, python: '', source: 'none', venvDir: '', pythonVersion: null, deface: null, onnxruntime: null, providers: [], gpu: false, message: 'PC のワーカーがまだ繋がっていません', checkedAt: new Date().toISOString()});
});

miscRouter.post('/settings/test/mosaic', async (_req, res) => {
  const w = await kvGet<WorkerStatus>('worker');
  res.json(w?.mosaic ?? {ok: false, python: '', source: 'none', venvDir: '', pythonVersion: null, deface: null, onnxruntime: null, providers: [], gpu: false, message: '顔モザイクの確認は PC 側で行われます', checkedAt: new Date().toISOString()});
});

// ───────────────────────── テロップのフォント ─────────────────────────

// クラウドからのバイナリ取り込みはローカルアプリへ案内する。
miscRouter.post('/fonts/token', (_req, res) => res.status(409).json({error: 'ローカル保存モードです。PC の Reel Studio を開いて取り込んでください'}));

/** 上げ終わったフォントを PC の置き場に入れさせる */
miscRouter.post('/fonts/ingest', (_req, res) => res.status(409).json({error: 'ローカル保存モードです。PC の Reel Studio を開いて取り込んでください'}));

/** 置き場から消させる（実体は PC にあるので、こちらもジョブで頼む） */
miscRouter.delete('/fonts/:file', async (req, res) => {
  const file = safeFontFile(req.params.file);
  if (!file) return res.status(400).json({error: 'ファイル名が不正です'});
  res.json(await addJob('fonts', '_studio', {remove: file}));
});

// ───────────────────────── 効果音 ─────────────────────────

const EMPTY_SFX: SfxLibrary = {version: 1, sounds: []};

// ───────────────────────── 参考動画のライブラリ（PC が一覧を送ってくる） ─────────────────────────

miscRouter.get('/video-styles', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json({entries: (await kvGet<{entries: unknown[]}>('video-styles'))?.entries ?? []});
});

miscRouter.get('/reference-library', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json({entries: (await kvGet<{entries: LibraryIndexEntry[]}>('reference-library'))?.entries ?? []});
});

/** 名前を付ける。実体は PC にあるので PC のジョブで行い、終わったら PC が一覧を送り直す */
miscRouter.put('/reference-library/:key', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title : '';
  res.json({job: await addJob('reference-library', '_studio', {op: 'rename', key: req.params.key, title})});
});

/** 1 本を消す（PC のジョブ。動画・コマ・分析が消える。案件に写した分析は残る） */
miscRouter.delete('/reference-library/:key', async (req, res) => {
  res.json({job: await addJob('reference-library', '_studio', {op: 'delete', key: req.params.key})});
});

miscRouter.get('/sfx', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json((await kvGet<{lib: SfxLibrary}>('sfx'))?.lib ?? EMPTY_SFX);
});

miscRouter.put('/sfx/sound', async (req, res) => {
  const parsed = SfxSoundSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error: '検証に失敗', issues: parsed.error.issues.slice(0, 10)});
  const file = parsed.data.file;
  if (!file) return res.status(400).json({error: 'file が必要'});
  const cur = (await kvGet<{lib: SfxLibrary; rev: number}>('sfx')) ?? {lib: EMPTY_SFX, rev: 0};
  const sound = cur.lib.sounds.find((s) => s.file === file);
  if (!sound) return res.status(404).json({error: `ライブラリにありません: ${file}`});
  Object.assign(sound, parsed.data);
  await kvSet('sfx', {lib: cur.lib, rev: cur.rev + 1, updatedBy: 'cloud'});
  res.json(cur.lib);
});

/** 永続ローカルサーバーでのみ音源を配信する。 */
miscRouter.get('/sfx/file/*', async (req, res) => {
  const rel = (req.params as Record<string, string>)[0] ?? '';
  const asset = await findAsset('_global', 'sfx', 'full', rel);
  if (!asset) return res.status(404).json({error: 'この音源はまだ PC から上がっていません'});
  res.sendFile(requireLocalMedia(asset.url), {headers: {'Cache-Control': 'private, no-cache'}, acceptRanges: true});
});

// ───────────────────────── 音声生成 ─────────────────────────

miscRouter.get('/tts/voices', async (_req, res) => {
  const s = await kvGet<SettingsView>('settings-view');
  try {
    res.setHeader('Cache-Control', 'no-cache');
    res.json(await listVoices(listPersonas(), s?.settings.tts.voices ?? [], {signal: AbortSignal.timeout(20_000)}));
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
  }
});

miscRouter.post('/tts/preview', async (req, res) => {
  const {text, voice, speed, latency} = req.body ?? {};
  try {
    const buf = await synthPreview(String(text ?? ''), {
      voice: String(voice ?? ''),
      speed: typeof speed === 'number' ? speed : undefined,
      latency: typeof latency === 'string' ? latency : undefined,
    });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(400).json({error: (e as Error).message});
  }
});

// ───────────────────────── 通知（Web Push） ─────────────────────────

miscRouter.get('/push/key', async (_req, res) => {
  res.json({key: publicKey(), available: pushAvailable(), subscriptions: pushAvailable() ? await countSubscriptions() : 0});
});

miscRouter.post('/push/subscribe', async (req, res) => {
  const sub = req.body?.subscription as {endpoint?: string; keys?: {p256dh?: string; auth?: string}} | undefined;
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys.auth) return res.status(400).json({error: 'subscription が不正です'});
  await saveSubscription({endpoint: sub.endpoint, keys: {p256dh: sub.keys.p256dh, auth: sub.keys.auth}}, typeof req.body?.label === 'string' ? req.body.label.slice(0, 80) : undefined);
  res.json({ok: true, subscriptions: await countSubscriptions()});
});

miscRouter.post('/push/unsubscribe', async (req, res) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
  if (endpoint) await removeSubscription(endpoint);
  res.json({ok: true, subscriptions: await countSubscriptions()});
});

/** 届くか確かめる（Settings の「テスト送信」） */
miscRouter.post('/push/test', async (_req, res) => {
  if (!pushAvailable()) return res.status(503).json({error: '通知の鍵（VAPID）が設定されていません'});
  res.json(await sendToAll({title: 'Reel Studio', body: '通知はここに届きます', url: '/'}));
});

// ───────────────────────── スマホからの素材アップロード ─────────────────────────

// 旧 API で Storage への書き込みが復活しないよう明示的に拒否する。
miscRouter.post('/uploads/token', (_req, res) => res.status(409).json({error: 'ローカル保存モードです。PC の Reel Studio を開いて取り込んでください'}));

/** 上げ終わったファイルを PC に取り込ませる */
miscRouter.post('/uploads/ingest', (_req, res) => res.status(409).json({error: 'ローカル保存モードです。PC の Reel Studio を開いて取り込んでください'}));
