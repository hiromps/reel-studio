// 効果音ライブラリ（<dataRoot>/sfx/）の一覧・役割の更新・試聴。
// 音源そのものは公開リポジトリに入らない（効果音ラボは再配布禁止）ので、ここから配信するのはローカルのファイル。
import {Router} from 'express';
import path from 'node:path';
import {readLibrary, sfxFilePath, writeLibrary} from '../../core/sfx';
import {SfxSoundSchema} from '../../shared/sfx';

export const sfxRouter = Router();

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
