// caption.txt の GET / PUT。契約ファイルと違って JSON ではなく素のテキストなので専用にする。
import {Router, type Request} from 'express';
import fs from 'node:fs';
import {captionPath, readCaption, resolveProjectDirStrict, writeCaption} from '../../core/project';
import {loadOrderEnv} from '../../core/order';
import {checkCaption} from '../../shared/caption';
import {fileEtag} from '../../core/json-io';

export const captionRouter = Router({mergeParams: true});

const slugOf = (req: Request): string => (req.params as unknown as {slug: string}).slug;

/** brief が無い案件でも 500 にしない（点検だけ諦める） */
const issuesOf = (dir: string, text: string) => {
  try {
    const {persona, brief} = loadOrderEnv(dir);
    return checkCaption(text, persona, {pr: brief.shop.pr});
  } catch {
    return [];
  }
};

captionRouter.get('/caption', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const text = readCaption(dir);
  const p = captionPath(dir);
  const etag = fs.existsSync(p) ? fileEtag(p) : null;
  if (etag) res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  res.json({etag, data: text, issues: text ? issuesOf(dir, text) : []});
});

captionRouter.put('/caption', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const text = req.body?.text;
  if (typeof text !== 'string') return res.status(400).json({error: 'text（文字列）が必要'});
  const p = captionPath(dir);
  const ifMatch = req.header('If-Match');
  const current = fs.existsSync(p) ? fileEtag(p) : null;
  if (ifMatch && current && ifMatch !== current) return res.status(409).json({error: 'ファイルが外部で変更された', etag: current, data: readCaption(dir)});
  writeCaption(dir, text);
  const etag = fileEtag(p)!;
  res.setHeader('ETag', etag);
  res.json({etag, issues: issuesOf(dir, text)});
});
