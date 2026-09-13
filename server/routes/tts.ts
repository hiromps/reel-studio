// 音声生成まわりの API。いまはボイス一覧だけ（生成そのものは tts ジョブ）。
import {Router} from 'express';
import {listVoices, synthPreview} from '../../core/tts';

export const ttsRouter = Router();

/** 選べるボイス（自分の Fish Audio モデル ＋ personas.ts のボイス）。鍵そのものは返さない */
/**
 * 試聴。渡された文・ボイス・速度で 1 本だけ作って wav をそのまま返す。
 * 案件のファイルには何も書かないので、速度を決める前に何度でも試せる。
 */
ttsRouter.post('/preview', async (req, res) => {
  const {text, voice, speed, latency} = req.body ?? {};
  try {
    const buf = await synthPreview(String(text ?? ''), {voice: String(voice ?? ''), speed: typeof speed === 'number' ? speed : undefined, latency: typeof latency === 'string' ? latency : undefined});
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(400).json({error: (e as Error).message});
  }
});

ttsRouter.get('/voices', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache');
    res.json(await listVoices());
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
  }
});
