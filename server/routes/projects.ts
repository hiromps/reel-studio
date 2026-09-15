import {Router} from 'express';
import fs from 'node:fs';
import {PersonaIdSchema} from '../../shared/schema/brief';
import {defaultPersonaId, findPersona} from '../../shared/personas';
import {cloneProject, createProject, listProjects, projectInfo, resolveProjectDirStrict} from '../../core/project';
import {jobs} from '../jobs';
import {state} from '../state';
import {watchProject} from '../watch';

export const projectsRouter = Router();

projectsRouter.get('/', (_req, res) => {
  res.json(listProjects());
});

projectsRouter.post('/', (req, res) => {
  const {slug, persona, shopName, install, from, facts} = req.body ?? {};
  if (!slug || typeof slug !== 'string') return res.status(400).json({error: 'slug が必要'});
  const lines: string[] = [];
  let dir: string;
  let created = true;
  try {
    if (typeof from === 'string' && from.trim()) {
      // 同じ素材で別バージョン。素材はハードリンクで共有し、catalog（タグ付けの成果）は引き継ぐ
      const p = persona ? PersonaIdSchema.safeParse(persona) : undefined;
      if (p && (!p.success || !findPersona(p.data))) return res.status(400).json({error: `人格が登録されていません: ${String(persona)}（Settings の「人格」で追加）`});
      const r = cloneProject(from.trim(), slug, {persona: p?.data, shopName, facts: facts !== false, onLine: (l) => lines.push(l)});
      dir = r.dir;
    } else {
      const p = PersonaIdSchema.safeParse(persona ?? defaultPersonaId());
      if (!p.success || !findPersona(p.data)) return res.status(400).json({error: `人格が登録されていません: ${String(persona ?? '')}（Settings の「人格」で追加）`});
      const r = createProject(slug, {persona: p.data, shopName});
      dir = r.dir;
      created = r.created;
    }
  } catch (e) {
    return res.status(400).json({error: (e as Error).message});
  }
  const info = projectInfo(dir);
  let jobId: string | undefined;
  if (install !== false && !info.nodeModules) jobId = jobs.add('npm-install', info.slug).id;
  res.json({...info, created, jobId, lines});
});

// 「いまの案件」はタブごとに違う（画面は URL の ?p= を見る）。ここに置くのは
// 「?p= 無しで開いた新しいタブの初期値」と「slug 省略でジョブを投げたときの宛先」だけ。
projectsRouter.get('/active', (_req, res) => {
  res.json({slug: state.activeSlug});
});

projectsRouter.put('/active', (req, res) => {
  const {slug} = req.body ?? {};
  if (slug !== undefined && slug !== null) {
    const dir = resolveProjectDirStrict(String(slug));
    if (!fs.existsSync(dir)) return res.status(404).json({error: `案件が無い: ${slug}`});
    state.activeSlug = String(slug).endsWith('-reel') ? String(slug) : `${slug}-reel`;
    watchProject(dir); // このタブが開いた案件も見張る（他のタブの案件は見張ったまま）
  }
  res.json({slug: state.activeSlug});
});

projectsRouter.get('/:slug', (req, res) => {
  const dir = resolveProjectDirStrict(req.params.slug);
  if (!fs.existsSync(dir)) return res.status(404).json({error: '案件が無い'});
  res.json(projectInfo(dir));
});
