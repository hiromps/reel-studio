// Settings 画面の裏側：設定の読み書き・接続テスト。鍵の値はどの応答にも入れない。
import {Router} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {DEFAULT_INSTAGRAM_MCP_URL, SettingsPatchSchema} from '../../shared/schema/settings';
import {fishKeyView, instagramKeyView, loadSettings, mergeSettings, saveSettings, settingsView} from '../../core/settings';
import {listFonts} from '../../core/fonts';
import {claudeAvailable, claudeBin, claudeBinInfo, claudeVersion, resetClaudeBin} from '../../core/agent';
import {fishEnv, probeFishKey, resetFishEnv} from '../../core/tts';
import {instagramMcpEnv, probeInstagramMcp, resetInstagramMcpEnv} from '../../core/instagram-mcp';
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
  return settingsView({bin: info.bin, available, source: info.source, version}, studioConfig.templateDir, listFonts());
};

settingsRouter.get('/', async (_req, res) => {
  try {
    res.json(await view());
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
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
