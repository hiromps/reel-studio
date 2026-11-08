// Settings 画面の裏側：設定の読み書き・接続テスト。鍵の値はどの応答にも入れない。
import {Router} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {AGENT_PROVIDERS, DEFAULT_INSTAGRAM_MCP_URL, SettingsPatchSchema, type AgentProvider, type ClaudeReconnectResult} from '../../shared/schema/settings';
import {agentProvider, deepseekApiKey, deepseekKeyView, fishKeyView, instagramKeyView, loadSettings, mergeSettings, saveSettings, settingsView} from '../../core/settings';
import {listFonts} from '../../core/fonts';
import {claudeAvailable, claudeBin, claudeBinInfo, claudeVersion, resetClaudeBin} from '../../core/agent';
import {codexAvailable, codexBinInfo, codexLoggedIn, codexVersion} from '../../core/codex';
import {listAgentModels} from '../../core/agent-models';
import {claudeAuthStatus, claudeLoginCommand, openClaudeLogin} from '../../core/claude-auth';
import {fishEnv, probeFishKey, resetFishEnv} from '../../core/tts';
import {instagramMcpEnv, probeInstagramMcp, resetInstagramMcpEnv} from '../../core/instagram-mcp';
import {probeDeepseekKey} from '../../shared/deepseek';
import {mosaicStatus, resetMosaicStatus} from '../../core/mosaic';
import {resolveProjectDir} from '../../core/project';
import {studioConfig} from '../../studio.config';
import {jobs} from '../jobs';
import {state} from '../state';

export const settingsRouter = Router();

const view = async () => {
  const info = claudeBinInfo();
  const available = claudeAvailable();
  const version = available ? await claudeVersion(info.bin) : null;
  const codex = codexBinInfo();
  const codexReady = codexAvailable();
  const auth = available ? await claudeAuthStatus(info.bin) : undefined;
  const result = settingsView({bin: info.bin, available, source: info.source, version, ...(auth ? {auth} : {})}, studioConfig.templateDir, listFonts());
  result.codex = {bin: codex.bin, available: codexReady, loggedIn: codexReady ? await codexLoggedIn(codex.bin) : false, source: codex.source, version: codexReady ? await codexVersion(codex.bin) : null};
  return result;
};

settingsRouter.get('/', async (_req, res) => {
  try {
    res.json(await view());
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
  }
});

/** モデル選択肢。入力中の DeepSeek 鍵でも更新できるよう POST にする。鍵は応答へ含めない。 */
settingsRouter.post('/models', async (req, res) => {
  const provider = req.body?.provider;
  if (!AGENT_PROVIDERS.includes(provider as AgentProvider)) return res.status(400).json({error: '接続先が不正です'});
  try {
    res.json(await listAgentModels(provider as AgentProvider, {deepseekKey: typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined, claudeKey: typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined, codexBin: typeof req.body?.bin === 'string' ? req.body.bin : undefined}));
  } catch (e) {
    res.status(502).json({error: (e as Error).message});
  }
});

settingsRouter.put('/', async (req, res) => {
  const parsed = SettingsPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({error: '検証に失敗', issues: parsed.error.issues.slice(0, 20)});
  const patch = parsed.data;
  const touchesFolders = patch.dataRoot !== undefined || patch.paths !== undefined;
  // フォルダを途中で差し替えると走っているジョブの書き出し先が迷子になる
  if (touchesFolders && jobs.list().some((j) => j.status === 'queued' || j.status === 'running'))
    return res.status(409).json({error: 'ジョブの実行中はフォルダの設定を変えられません。終わるか中止してから保存してください'});
  try {
    saveSettings(mergeSettings(loadSettings(), patch));
  } catch (e) {
    return res.status(400).json({error: (e as Error).message});
  }
  resetFishEnv();
  resetInstagramMcpEnv();
  resetClaudeBin();
  resetMosaicStatus();
  // 「いまの案件」が新しいフォルダに無ければ忘れる（無い案件を見張り続けない）
  if (touchesFolders && state.activeSlug && !fs.existsSync(resolveProjectDir(state.activeSlug))) state.activeSlug = null;
  try {
    res.json(await view());
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
  }
});

/** Fish Audio に鍵が通るか。本文の apiKey があればそれを、無ければ保存済み／環境変数の鍵を試す。鍵は返さない */
settingsRouter.post('/test/tts', async (req, res) => {
  const typed = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  const key = typed || fishEnv()?.apiKey || '';
  if (!key) return res.json({ok: false, message: 'API キーが未設定です'});
  const r = await probeFishKey(key, {signal: AbortSignal.timeout(15_000)});
  res.json({...r, source: typed ? 'input' : fishKeyView().source});
});

/**
 * Smartgram の MCP に鍵が通り、裏取りに使うツールが揃っているか。本文の mcpKey / mcpUrl（入力中の値）が
 * あればそれを、無ければ保存済み／環境変数のものを試す。鍵は返さない。登録アカウントの一覧を返す
 */
settingsRouter.post('/test/instagram', async (req, res) => {
  const typedKey = typeof req.body?.mcpKey === 'string' ? req.body.mcpKey.trim() : '';
  const typedUrl = typeof req.body?.mcpUrl === 'string' ? req.body.mcpUrl.trim() : '';
  const saved = instagramMcpEnv();
  const apiKey = typedKey || saved?.apiKey || '';
  const url = typedUrl || saved?.url || DEFAULT_INSTAGRAM_MCP_URL;
  if (!apiKey) return res.json({ok: false, message: 'MCP 用の API キーが未設定です'});
  if (!/^https?:\/\//.test(url)) return res.json({ok: false, message: `MCP サーバーの URL が不正です: ${url}`});
  const r = await probeInstagramMcp({url, apiKey}, {signal: AbortSignal.timeout(25_000)});
  res.json({...r, url, source: typedKey ? 'input' : instagramKeyView().source});
});

/** claude --version が動くか。本文の bin があればそれを試す */
settingsRouter.post('/test/claude', async (req, res) => {
  const typed = typeof req.body?.bin === 'string' ? req.body.bin.trim() : '';
  const bin = typed || claudeBin();
  if (path.isAbsolute(bin) && !fs.existsSync(bin)) return res.json({ok: false, bin, version: null, message: `ファイルが見つかりません: ${bin}`});
  const version = await claudeVersion(bin);
  res.json({
    ok: !!version,
    bin,
    version,
    message: version ? `動きました（${version}）` : 'claude --version が動きませんでした。Claude Code のインストールと、ターミナルで claude を一度起動してログイン済みかを確認してください',
  });
});

/** PC の claude CLI のログイン状態（課金なし）。画面の「Claude に再接続」が待つあいだ数秒おきに読む */
settingsRouter.get('/claude/auth', async (_req, res) => {
  if (!claudeAvailable()) return res.json({available: false, auth: null, command: claudeLoginCommand()});
  res.json({available: true, auth: await claudeAuthStatus(), command: claudeLoginCommand()});
});

/** `claude auth login` を PC のターミナルで開く（ブラウザでの承認は人がする） */
settingsRouter.post('/claude/login', (_req, res) => {
  if (!claudeAvailable()) return res.status(409).json({error: 'claude 実行ファイルが見つかりません。Claude Code をインストールしてください'});
  const opened = openClaudeLogin();
  res.json({opened, command: claudeLoginCommand(), message: opened ? 'ログイン用のウィンドウを開きました。ブラウザで承認してください' : `このPCではウィンドウを開けません。ターミナルで ${claudeLoginCommand()} を実行してください`});
});

/**
 * 接続先を Claude（PC でログイン中の claude CLI）に戻す。ログイン済みならそのまま切り替えて保存し、
 * 未ログイン・期限切れならログイン画面を開いて login-started を返す（画面は /claude/auth を待ってから呼び直す）
 */
settingsRouter.post('/claude/reconnect', async (req, res) => {
  const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
  const reply = (r: ClaudeReconnectResult) => res.json(r);
  if (!claudeAvailable()) return reply({state: 'failed', auth: null, message: 'claude 実行ファイルが見つかりません。Claude Code をインストールするか、「高度な設定」で場所を指定してください'});
  const auth = await claudeAuthStatus();
  if (!auth.loggedIn) {
    if (req.body?.openLogin === false) return reply({state: 'failed', auth, message: auth.error ?? 'Claude にログインしていません'});
    const opened = openClaudeLogin();
    return reply({state: 'login-started', auth, message: opened ? 'ログイン用のウィンドウを開きました。ブラウザで承認すると自動で切り替わります' : `ターミナルで ${claudeLoginCommand()} を実行してログインしてください`});
  }
  try {
    saveSettings(mergeSettings(loadSettings(), {agent: {provider: 'claude', ...(model ? {model} : {})}}));
  } catch (e) {
    return reply({state: 'failed', auth, message: `保存に失敗しました: ${(e as Error).message}`});
  }
  resetClaudeBin();
  if (agentProvider() !== 'claude') return reply({state: 'failed', auth, message: '環境変数 REEL_STUDIO_AGENT_PROVIDER が別の接続先を指定しているため切り替えられません'});
  reply({state: 'connected', auth, message: `Claude に接続しました${auth.plan ? `（${auth.plan}）` : ''}`, view: await view()});
});

settingsRouter.post('/test/codex', async (req, res) => {
  const typed = typeof req.body?.bin === 'string' ? req.body.bin.trim() : '';
  const bin = typed || codexBinInfo().bin;
  if (path.isAbsolute(bin) && !fs.existsSync(bin)) return res.json({ok: false, bin, version: null, message: `ファイルが見つかりません: ${bin}`});
  const version = await codexVersion(bin);
  const loggedIn = version ? await codexLoggedIn(bin) : false;
  res.json({ok: !!version && loggedIn, bin, version, message: !version ? 'codex --version が動きませんでした。Codex CLI のインストールを確認してください' : loggedIn ? `動きました（${version}）` : 'Codex CLI にログインしていません。ターミナルで codex login を実行してください'});
});

/** DeepSeek の鍵が通るか（残高 API。課金なし）。本文の apiKey があればそれを、無ければ保存済み／環境変数の鍵を試す。鍵は返さない */
settingsRouter.post('/test/deepseek', async (req, res) => {
  const typed = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  const key = typed || deepseekApiKey() || '';
  if (!key) return res.json({ok: false, message: 'DeepSeek の API キーが未設定です'});
  const r = await probeDeepseekKey(key, {signal: AbortSignal.timeout(15_000)});
  res.json({...r, source: typed ? 'input' : deepseekKeyView().source});
});

/** 顔モザイク（deface）が使えるか。python を起動して確かめるので結果は覚えておく（?refresh=1 で確かめ直す） */
settingsRouter.get('/mosaic', async (req, res) => {
  try {
    res.json(await mosaicStatus({refresh: req.query.refresh === '1'}));
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
  }
});

/** 本文の python（入力中の値）で deface が動くか。無ければ今の設定で確かめ直す */
settingsRouter.post('/test/mosaic', async (req, res) => {
  const typed = typeof req.body?.python === 'string' ? req.body.python.trim() : '';
  if (typed && path.isAbsolute(typed) && !fs.existsSync(typed)) return res.json({ok: false, python: typed, message: `ファイルが見つかりません: ${typed}`});
  res.json(await mosaicStatus(typed ? {python: typed} : {refresh: true}));
});
