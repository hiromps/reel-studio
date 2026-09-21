// 契約ファイル（catalog / brief / cuts / narration）の GET / PUT。ETag + If-Match で競合を検出する。
import {Router, type Request} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type {ZodTypeAny} from 'zod';
import {BriefSchema, CatalogSchema, NarrationSchema, ReelDataSchema} from '../../shared/schema';
import {fileEtag, readJsonLoose, writeJsonAtomic} from '../../core/json-io';
import {backupsDir, resolveProjectDirStrict, CONTRACT_FILES, type ContractName} from '../../core/project';
import {validateProject} from '../../core/render';
import {ensureProjectFont} from '../../core/fonts';

export const filesRouter = Router({mergeParams: true});

/** mergeParams で親ルートの :slug を受ける（express の型は親パラメータを知らない） */
const slugOf = (req: Request): string => (req.params as unknown as {slug: string}).slug;

const schemas: Record<ContractName, ZodTypeAny> = {catalog: CatalogSchema, brief: BriefSchema, cuts: ReelDataSchema, narration: NarrationSchema};

const filePath = (slug: string, name: string): string | null => {
  if (!(CONTRACT_FILES as readonly string[]).includes(name)) return null;
  return path.join(resolveProjectDirStrict(slug), `${name}.json`);
};

filesRouter.get('/:name', (req, res) => {
  const p = filePath(slugOf(req), req.params.name);
  if (!p) return res.status(400).json({error: 'name は catalog|brief|cuts|narration'});
  // 無いファイルは 404 ではなく data:null（narration.json 等は無いのが普通。ブラウザのコンソールを汚さない）
  if (!fs.existsSync(p)) return res.json({etag: null, data: null});
  const etag = fileEtag(p)!;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  res.json({etag, data: readJsonLoose(p)});
});

filesRouter.put('/:name', (req, res) => {
  const slug = slugOf(req);
  const name = req.params.name as ContractName;
  const p = filePath(slug, name);
  if (!p) return res.status(400).json({error: 'name は catalog|brief|cuts|narration'});
  const dir = resolveProjectDirStrict(slug);
  const ifMatch = req.header('If-Match');
  const current = fileEtag(p);
  if (ifMatch && current && ifMatch !== current) {
    return res.status(409).json({error: 'ファイルが外部で変更された', etag: current, data: readJsonLoose(p)});
  }
  const parsed = schemas[name].safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error: '検証に失敗', issues: parsed.error.issues.slice(0, 20)});
  writeJsonAtomic(p, parsed.data, {backupDir: backupsDir(dir)});
  // 自前フォントを指定されたら、置き場から案件の public/fonts/ へ配る（プレビューがすぐ効く）
  if (name === 'cuts') ensureProjectFont(dir, (parsed.data as {font?: string}).font);
  const etag = fileEtag(p)!;
  res.setHeader('ETag', etag);
  const validation = name === 'cuts' ? validateProject(dir, {cuts: parsed.data}) : undefined;
  res.json({etag, validation});
});
