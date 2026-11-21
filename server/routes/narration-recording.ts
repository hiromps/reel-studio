// マイク録音・外部から読み込んだナレーションを narration/<id>.wav に置く。画面側で 16bit PCM WAV に変換済みのものだけ受け取る。
import express, {Router, type Request} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {resolveProjectDirStrict} from '../../core/project';
import {RECORDING_MAX_BYTES, readWavInfo} from '../../shared/wav';

export const narrationRecordingRouter = Router({mergeParams: true});

narrationRecordingRouter.post('/narration-recording/:segmentId', express.raw({type: () => true, limit: RECORDING_MAX_BYTES}), (req: Request, res) => {
  try {
    const {slug, segmentId} = req.params as {slug: string; segmentId: string};
    // mic_ = マイク録音 / ext_ = 外部の音声ファイルを読み込んだもの（どちらも画面側で WAV にしてから送る）
    if (!/^(mic|ext)_[a-zA-Z0-9_-]+$/.test(segmentId)) return res.status(400).json({error: '音声 ID が不正です'});
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    const info = body ? readWavInfo(body) : null;
    if (!body || !info) return res.status(400).json({error: '録音データが WAV ではありません'});
    if (info.durSec < 0.2) return res.status(400).json({error: '録音が短すぎます'});
    const dir = path.join(resolveProjectDirStrict(slug), 'narration');
    fs.mkdirSync(dir, {recursive: true});
    // 既存の音声は上書きしない（ID は毎回新しく作る）
    fs.writeFileSync(path.join(dir, `${segmentId}.wav`), body, {flag: 'wx'});
    res.json({durSec: info.durSec});
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    res.status(code === 'EEXIST' ? 409 : 400).json({error: code === 'EEXIST' ? '同じ ID の音声が既にあります' : (error as Error).message});
  }
});
