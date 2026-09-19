// script.md（自然言語の台本）の GET / PUT。契約ファイルと違って素のテキスト。
import {Router, type Request} from 'express';
import fs from 'node:fs';
import {applyScriptProposal, readScript, scriptPath, scriptProposalView, writeScript} from '../../core/script';
import {jobs} from '../jobs';
import {resolveProjectDir, resolveProjectDirStrict} from '../../core/project';
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

/** 「割り当てを見るだけ」の結果（保存してある案を、いまの台本・素材で見直したもの）。無ければ data: null */
scriptRouter.get('/script/plan', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  res.setHeader('Cache-Control', 'no-cache');
  res.json({data: scriptProposalView(dir)});
});

/** 承認：保存してある案を cuts.json と narration.json に書き込む（AI は走らせない） */
scriptRouter.post('/script/plan/apply', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  // 同じ案件のジョブ（AI の修正・組み立て等）が cuts.json を書いている最中に上書きしない
  const busy = jobs.list().find((j) => (j.status === 'running' || j.status === 'queued') && resolveProjectDir(j.slug) === dir);
  if (busy) return res.status(409).json({error: `この案件でジョブ（${busy.type}）が動いています。終わってから書き込んでください`});
  try {
    const r = applyScriptProposal(dir);
    res.json({...r, view: scriptProposalView(dir)});
  } catch (e) {
    res.status(400).json({error: (e as Error).message, view: scriptProposalView(dir)});
  }
});

scriptRouter.put('/script', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const text = req.body?.text;
  if (typeof text !== 'string') return res.status(400).json({error: 'text（文字列）が必要'});
  writeScript(dir, text);
  res.json({etag: fileEtag(scriptPath(dir)), ...info(text)});
});
