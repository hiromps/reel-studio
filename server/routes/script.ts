// script.md（自然言語の台本）の GET / PUT。契約ファイルと違って素のテキスト。
import {Router, type Request} from 'express';
import fs from 'node:fs';
import {readScript, scriptPath, writeScript} from '../../core/script';
import {resolveProjectDirStrict} from '../../core/project';
import {parseSections, scriptTotalSec} from '../../shared/script';
import {fileEtag} from '../../core/json-io';

export const scriptRouter = Router({mergeParams: true});

const slugOf = (req: Request): string => (req.params as unknown as {slug: string}).slug;

/** 台本から読み取れた区間も返す（画面で「ちゃんと読めているか」を見せるため） */
const info = (text: string | null) => {
  const sections = text ? parseSections(text) : [];
  return {sections, totalSec: scriptTotalSec(sections) ?? null};
};

scriptRouter.get('/script', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const text = readScript(dir);
  const p = scriptPath(dir);
  const etag = fs.existsSync(p) ? fileEtag(p) : null;
  if (etag) res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  res.json({etag, data: text, ...info(text)});
});

scriptRouter.put('/script', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const text = req.body?.text;
  if (typeof text !== 'string') return res.status(400).json({error: 'text（文字列）が必要'});
  writeScript(dir, text);
  res.json({etag: fileEtag(scriptPath(dir)), ...info(text)});
});
