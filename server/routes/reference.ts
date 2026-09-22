// 参考動画（バズ動画の型を写す元）の GET / 取り込み / 別案件からの複製 / 取り消し。
// 分析（claude）と型を写す工程はジョブ（ai-reference / ai-mimic）。ここはファイルの出し入れだけ。
import {Router, type Request} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {copyReferenceFrom, deleteReference, importReferenceVideo, readReference, referenceInboxDir, referencePath} from '../../core/reference';
import {resolveProjectDirStrict} from '../../core/project';
import {fileEtag} from '../../core/json-io';
import {jobs} from '../jobs';

export const referenceRouter = Router({mergeParams: true});

const slugOf = (req: Request): string => (req.params as unknown as {slug: string}).slug;

/** ファイル名に使えない文字を落とす（フォルダを掘られないように） */
const safeName = (s: string): string => s.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();

const view = (dir: string) => {
  const p = referencePath(dir);
  return {etag: fs.existsSync(p) ? fileEtag(p) : null, data: readReference(dir)};
};

/** 同じ案件でジョブが動いている間は取り込み・複製・取り消しをしない（分析中に動画を差し替えない） */
const busyOf = (dir: string) => jobs.list().find((j) => (j.status === 'running' || j.status === 'queued') && j.slug && resolveProjectDirStrictSafe(j.slug) === dir);
const resolveProjectDirStrictSafe = (slug: string): string | null => {
  try {
    return resolveProjectDirStrict(slug);
  } catch {
    return null;
  }
};

referenceRouter.get('/reference', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const v = view(dir);
  if (v.etag) res.setHeader('ETag', v.etag);
  res.setHeader('Cache-Control', 'no-cache');
  res.json(v);
});

/**
 * 取り込み。本文は動画ファイルそのもの（JSON ではない）で、名前は ?filename= で渡す。
 * メモリに溜めずに一時ファイルへ流し、書き終わってから .studio/reference/ に移す。
 */
referenceRouter.post('/reference/upload', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const name = safeName(String(req.query.filename ?? ''));
  if (!name) return res.status(400).json({error: 'filename が必要'});
  const busy = busyOf(dir);
  if (busy) return res.status(409).json({error: `この案件でジョブ（${busy.type}）が動いています。終わってから取り込んでください`});
  const inbox = referenceInboxDir(dir);
  fs.mkdirSync(inbox, {recursive: true});
  const tmp = path.join(inbox, `${Date.now()}_${name}`);
  const ws = fs.createWriteStream(tmp);
  let failed = false;
  const fail = (status: number, message: string) => {
    if (failed) return;
    failed = true;
    fs.rmSync(tmp, {force: true});
    if (!res.headersSent) res.status(status).json({error: message});
  };
  req.on('aborted', () => fail(400, '送信が途中で切れました'));
  ws.on('error', (e) => fail(500, e.message));
  ws.on('finish', () => {
    if (failed) return;
    void importReferenceVideo(dir, tmp, {originalName: name, move: true})
      .then((data) => res.json({etag: fileEtag(referencePath(dir)), data}))
      .catch((e: Error) => fail(400, e.message));
  });
  req.pipe(ws);
});

/** PC 上のファイルを指定して取り込む（CLI と同じ経路。クラウドには無い） */
referenceRouter.post('/reference/import', async (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const file = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
  if (!file) return res.status(400).json({error: 'path（動画ファイルの場所）が必要'});
  const busy = busyOf(dir);
  if (busy) return res.status(409).json({error: `この案件でジョブ（${busy.type}）が動いています。終わってから取り込んでください`});
  try {
    const data = await importReferenceVideo(dir, path.resolve(file));
    res.json({etag: fileEtag(referencePath(dir)), data});
  } catch (e) {
    res.status(400).json({error: (e as Error).message});
  }
});

/** 別の案件の分析（reference.json とコマ）をそのまま使う */
referenceRouter.post('/reference/copy-from', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const from = typeof req.body?.from === 'string' ? req.body.from.trim() : '';
  if (!from) return res.status(400).json({error: 'from（元の案件）が必要'});
  const busy = busyOf(dir);
  if (busy) return res.status(409).json({error: `この案件でジョブ（${busy.type}）が動いています。終わってから複製してください`});
  try {
    const data = copyReferenceFrom(dir, resolveProjectDirStrict(from));
    res.json({etag: fileEtag(referencePath(dir)), data});
  } catch (e) {
    res.status(400).json({error: (e as Error).message});
  }
});

referenceRouter.delete('/reference', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const busy = busyOf(dir);
  if (busy) return res.status(409).json({error: `この案件でジョブ（${busy.type}）が動いています。終わってから取り消してください`});
  deleteReference(dir);
  res.json(view(dir));
});
