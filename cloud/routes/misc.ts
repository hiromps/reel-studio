// config / personas / settings / sfx / tts / アップロード。
//
// PC でしか分からないこと（ffmpeg の有無・claude のバージョン・フォルダの実在・deface）は、
// ワーカーが kv に置いたスナップショットを返す。PC でしかできない操作（フォルダ選択ダイアログ）は
// 501 を返し、画面はクラウドではそのボタンを出さない。
import {Router} from 'express';
import {generateClientTokenFromReadWriteToken} from '@vercel/blob/client';
import {PersonaIdSchema} from '../../shared/schema/brief';
import {BUILTIN_PERSONAS, PersonaSchema, findPersona, listPersonas, setPersonas, type Persona} from '../../shared/personas';
import {SettingsPatchSchema, type SettingsView} from '../../shared/schema/settings';
import {SfxSoundSchema, type SfxLibrary} from '../../shared/sfx';
import {JOB_TYPES} from '../../shared/jobs';
import {normalizeSlug} from '../../shared/project';
import {blobPath} from '../blob';
import {fishEnv, listVoices, probeFishKey, synthPreview} from '../fish';
import {addJob, findAsset, kvGet, kvSet, listJobs, listProjects, replacePersonas} from '../store';
import {WORKER_ONLINE_MS, type WorkerStatus} from '../worker-status';

export const miscRouter = Router();

// ───────────────────────── config ─────────────────────────

miscRouter.get('/config', async (_req, res) => {
  const [w, s] = [await kvGet<WorkerStatus>('worker'), await kvGet<SettingsView>('settings-view')];
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
    startedAt: w?.lastSeen ?? new Date().toISOString(),
    uploadsFolders: w?.uploadsFolders ?? [],
    // ── ここからクラウド版だけが返すもの（画面がローカル専用 UI を隠すのに使う） ──
    mode: 'cloud' as const,
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
      settings: {version: 1, paths: {}, tts: {provider: 'fish-audio', modelId: 's2.1-pro-free', voices: [], apiKey: {present: false, masked: '', source: null}}, agent: {model: 'opus', tagBatchSize: 8, tagConcurrency: 3, timeoutMin: 20}, mosaic: {}} as unknown as SettingsView['settings'],
      paths: {} as SettingsView['paths'],
      env: {fishApiKey: false, fishModelId: false, claudeBin: false, agentModel: false, mosaicPython: false},
      claude: {bin: '', available: false, source: 'none', version: null},
    } as SettingsView);
  const env = fishEnv();
  return {
    ...base,
    // 音声生成の鍵はクラウド側（Vercel の環境変数）を使う。PC の鍵は PC のジョブが使う
    settings: {...base.settings, tts: {...base.settings.tts, apiKey: env ? {present: true, masked: '••••（Vercel）', source: 'env'} : base.settings.tts.apiKey}},
    env: {...base.env, fishApiKey: !!env},
    claude: base.claude.available ? base.claude : {...base.claude, version: w?.claudeVersion ?? base.claude.version, available: !!w?.claude},
  };
};

miscRouter.get('/settings', async (_req, res) => res.json(await settingsViewCloud()));

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

miscRouter.post('/settings/test/tts', async (req, res) => {
  const typed = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  const key = typed || fishEnv()?.apiKey || '';
  if (!key) return res.json({ok: false, message: 'API キーが未設定です（Vercel の環境変数 FISH_API_KEY）'});
  res.json({...(await probeFishKey(key, {signal: AbortSignal.timeout(15_000)})), source: typed ? 'input' : 'env'});
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

miscRouter.get('/settings/mosaic', async (_req, res) => {
  const w = await kvGet<WorkerStatus>('worker');
  res.json(w?.mosaic ?? {ok: false, python: '', source: 'none', venvDir: '', pythonVersion: null, deface: null, onnxruntime: null, providers: [], gpu: false, message: 'PC のワーカーがまだ繋がっていません', checkedAt: new Date().toISOString()});
});

miscRouter.post('/settings/test/mosaic', async (_req, res) => {
  const w = await kvGet<WorkerStatus>('worker');
  res.json(w?.mosaic ?? {ok: false, python: '', source: 'none', venvDir: '', pythonVersion: null, deface: null, onnxruntime: null, providers: [], gpu: false, message: '顔モザイクの確認は PC 側で行われます', checkedAt: new Date().toISOString()});
});

// ───────────────────────── 効果音 ─────────────────────────

const EMPTY_SFX: SfxLibrary = {version: 1, sounds: []};

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

/** 試聴。PC から上がっている音源（Blob）へ飛ばす */
miscRouter.get('/sfx/file/*', async (req, res) => {
  const rel = (req.params as Record<string, string>)[0] ?? '';
  const asset = await findAsset('_global', 'sfx', 'full', rel);
  if (!asset) return res.status(404).json({error: 'この音源はまだ PC から上がっていません'});
  res.redirect(307, asset.url);
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

// ───────────────────────── スマホからの素材アップロード ─────────────────────────

/**
 * Vercel Functions の本文上限（4.5MB）では動画を送れないので、ブラウザから Blob に直接上げる。
 * ここが出すのは「その 1 ファイルだけ書き込める」短命のトークン。
 * 上げ終わったら ingest ジョブを積み、PC が Blob から取り込んで uploads/ に置く。
 */
miscRouter.post('/uploads/token', async (req, res) => {
  const slug = typeof req.body?.slug === 'string' ? normalizeSlug(req.body.slug) : '';
  const name = typeof req.body?.filename === 'string' ? req.body.filename.replace(/[\\/]/g, '_').trim() : '';
  const folder = typeof req.body?.folder === 'string' ? req.body.folder.replace(/[\\/]/g, '_').trim() : '';
  if (!slug || !name) return res.status(400).json({error: 'slug と filename が必要'});
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(503).json({error: 'BLOB_READ_WRITE_TOKEN が未設定です'});
  const pathname = blobPath(slug, 'uploads', 'full', `_inbox/${Date.now()}_${name}`);
  try {
    const clientToken = await generateClientTokenFromReadWriteToken({
      token,
      pathname,
      allowedContentTypes: ['video/*', 'image/*', 'application/octet-stream'],
      // 1 時間で失効（大きな動画でも上げ切れる長さ）
      validUntil: Date.now() + 60 * 60 * 1000,
      addRandomSuffix: true,
      maximumSizeInBytes: 4 * 1024 * 1024 * 1024,
    });
    res.json({token: clientToken, pathname, folder});
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
  }
});

/** 上げ終わったファイルを PC に取り込ませる */
miscRouter.post('/uploads/ingest', async (req, res) => {
  const slug = typeof req.body?.slug === 'string' ? normalizeSlug(req.body.slug) : '';
  const files = Array.isArray(req.body?.files) ? (req.body.files as {url: string; name: string}[]) : [];
  const folder = typeof req.body?.folder === 'string' ? req.body.folder : '';
  if (!slug || !files.length) return res.status(400).json({error: 'slug と files が必要'});
  res.json(await addJob('ingest', slug, {files, folder}));
});
