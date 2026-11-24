// 効果音ライブラリ（<dataRoot>/sfx/）の一覧・役割の更新・試聴。
// 音源そのものは公開リポジトリに入らない（効果音ラボは再配布禁止）ので、ここから配信するのはローカルのファイル。
import express, {Router} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {readLibrary, scanLibrary, sfxDir, sfxFilePath, writeLibrary} from '../../core/sfx';
import {SfxSoundSchema} from '../../shared/sfx';
import {BGM_FOLDER, BGM_MAX_BYTES, safeBgmFileName} from '../../shared/bgm';

export const sfxRouter = Router();

/**
 * BGM を取り込む。本文がファイルそのもの、名前は ?name= で受け取り sfx/BGM/ に保存してライブラリを読み直す。
 * 同じ名前の曲があるときは上書きせず「名前 (2).mp3」のように別名にする（既に使っている案件の音が変わらないように）
 */
sfxRouter.post('/bgm', express.raw({type: () => true, limit: BGM_MAX_BYTES}), async (req, res) => {
  try {
    const name = safeBgmFileName(String(req.query.name ?? ''));
    if (!name) return res.status(400).json({error: '音声ファイル（mp3 / wav / m4a / ogg / opus / flac）を選んでください'});
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    if (!body || body.length < 1024) return res.status(400).json({error: 'ファイルが空か、短すぎます'});
    const dir = path.join(sfxDir(), BGM_FOLDER);
    fs.mkdirSync(dir, {recursive: true});
    const ext = path.extname(name);
    const stem = name.slice(0, -ext.length);
    let fileName = name;
    for (let n = 2; fs.existsSync(path.join(dir, fileName)); n++) fileName = `${stem} (${n})${ext}`;
    fs.writeFileSync(path.join(dir, fileName), body, {flag: 'wx'});
    const {lib} = await scanLibrary();
    const file = `${BGM_FOLDER}/${fileName}`;
    const sound = lib.sounds.find((s) => s.file === file);
    if (!sound?.durSec) {
      // ffprobe で長さが読めない＝音声として壊れている。台帳ごと戻す
      fs.rmSync(path.join(dir, fileName), {force: true});
      await scanLibrary();
      return res.status(400).json({error: '音声として読み込めませんでした'});
    }
    res.json({file, lib: readLibrary()});
  } catch (error) {
    res.status(400).json({error: (error as Error).message});
  }
});

sfxRouter.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json(readLibrary());
});

/** 1 音の設定（役割・trim・fade・gain・表示名）を更新する */
sfxRouter.put('/sound', (req, res) => {
  const parsed = SfxSoundSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error: '検証に失敗', issues: parsed.error.issues.slice(0, 10)});
  const file = parsed.data.file;
  if (!file) return res.status(400).json({error: 'file が必要'});
  const lib = readLibrary();
  const sound = lib.sounds.find((s) => s.file === file);
  if (!sound) return res.status(404).json({error: `ライブラリにありません: ${file}`});
  Object.assign(sound, parsed.data);
  writeLibrary(lib);
  res.json(lib);
});

/** 試聴用。GUI の <audio> がこれを鳴らす */
sfxRouter.get('/file/*', (req, res) => {
  const rel = (req.params as Record<string, string>)[0] ?? '';
  const abs = sfxFilePath(rel);
  if (!abs) return res.status(404).end();
  const ext = path.extname(abs).toLowerCase();
  const type = ext === '.wav' ? 'audio/wav' : ext === '.ogg' || ext === '.opus' ? 'audio/ogg' : ext === '.flac' ? 'audio/flac' : ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg';
  res.sendFile(abs, {headers: {'Content-Type': type, 'Cache-Control': 'no-cache'}, acceptRanges: true});
});
