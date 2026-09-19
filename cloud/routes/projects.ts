// 案件の一覧・作成・既定の案件。ローカル版 server/routes/projects.ts と同じ形を返す。
//
// 作成は 2 段構え:
//   1. ここで projects 行と brief の雛形を即座に作る（画面がすぐ次に進める）
//   2. create-project ジョブを積み、PC 側で実フォルダ（Remotion プロジェクト・npm install）を作る
// 複製（from 付き）は素材のハードリンクなど PC でしかできないことが本体なので、全部ジョブに任せる。
import {Router} from 'express';
import {PersonaIdSchema} from '../../shared/schema/brief';
import {defaultPersonaId, findPersona} from '../../shared/personas';
import {briefSkeleton, isSafeSlug, normalizeSlug} from '../../shared/project';
import {addJob, kvGet, kvSet, listProjects, projectInfo, upsertProject, writeDoc} from '../store';

export const projectsRouter = Router();

projectsRouter.get('/', async (_req, res) => {
  res.json(await listProjects());
});

projectsRouter.post('/', async (req, res) => {
  const {slug: rawSlug, persona, shopName, install, from, facts, carryTimeline} = req.body ?? {};
  if (!rawSlug || typeof rawSlug !== 'string') return res.status(400).json({error: 'slug が必要'});
  if (!isSafeSlug(rawSlug)) return res.status(400).json({error: `案件名が不正です: ${rawSlug}`});
  const slug = normalizeSlug(rawSlug.trim());

  const cloning = typeof from === 'string' && !!from.trim();
  const p = PersonaIdSchema.safeParse(persona ?? (cloning ? undefined : defaultPersonaId()));
  if (!cloning || persona !== undefined) {
    if (!p.success || !findPersona(p.data)) return res.status(400).json({error: `人格が登録されていません: ${String(persona ?? '')}（Settings の「人格」で追加）`});
  }
  const personaId = p.success ? p.data : undefined;

  const existing = await projectInfo(slug);
  const created = !existing;
  await upsertProject(slug, {persona: personaId ?? null, shopName: typeof shopName === 'string' ? shopName : null});

  const lines: string[] = [];
  if (!cloning && created && personaId) {
    // 雛形の brief。PC 側の createProject も同じものを書くので、どちらが先でも同じ内容になる
    const brief = briefSkeleton(personaId, typeof shopName === 'string' ? shopName : '');
    await writeDoc(slug, 'brief', brief, {by: 'cloud'});
    await upsertProject(slug, {format: brief.format ?? null});
    lines.push('brief.json の雛形を作りました');
  }

  const job = await addJob('create-project', slug, {
    persona: personaId,
    shopName: typeof shopName === 'string' ? shopName : undefined,
    install: install !== false,
    from: cloning ? String(from).trim() : undefined,
    facts: facts !== false,
    carryTimeline: !!carryTimeline,
  });
  if (cloning) lines.push(`${String(from).trim()} からの複製を PC に依頼しました（素材はハードリンクで共有されます）`);

  const info = await projectInfo(slug);
  res.json({...info, created, jobId: job.id, lines});
});

// 「いまの案件」はタブごとに違う（画面は URL の ?p= を見る）。ここに置くのは
// 「?p= 無しで開いた新しいタブの初期値」だけ。
projectsRouter.get('/active', async (_req, res) => {
  res.json({slug: (await kvGet<{slug: string | null}>('active-slug'))?.slug ?? null});
});

projectsRouter.put('/active', async (req, res) => {
  const {slug} = req.body ?? {};
  if (slug !== undefined && slug !== null) {
    if (!isSafeSlug(String(slug))) return res.status(400).json({error: `案件名が不正です: ${slug}`});
    const norm = normalizeSlug(String(slug));
    if (!(await projectInfo(norm))) return res.status(404).json({error: `案件が無い: ${slug}`});
    await kvSet('active-slug', {slug: norm});
    return res.json({slug: norm});
  }
  res.json({slug: (await kvGet<{slug: string | null}>('active-slug'))?.slug ?? null});
});

projectsRouter.get('/:slug', async (req, res) => {
  const info = await projectInfo(normalizeSlug(req.params.slug));
  if (!info) return res.status(404).json({error: '案件が無い'});
  res.json(info);
});
