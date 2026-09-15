// 人格（persona）の一覧・追加・編集・削除。実体は ~/.reel-studio/personas.json。
import {Router} from 'express';
import {PersonaIdSchema} from '../../shared/schema/brief';
import {BUILTIN_PERSONAS, PersonaSchema, findPersona, listPersonas, type Persona} from '../../shared/personas';
import {personasProblem, savePersonas} from '../../core/personas-store';
import {personasFile} from '../../core/settings';
import {listProjects} from '../../core/project';

export const personasRouter = Router();

const listView = () => ({personas: listPersonas(), file: personasFile(), builtinIds: BUILTIN_PERSONAS.map((p) => p.id), problem: personasProblem()});

personasRouter.get('/', (_req, res) => {
  res.json(listView());
});

/** 新規（persona を丸ごと）か、複製（from + id [+ label]） */
personasRouter.post('/', (req, res) => {
  const {from, id, label, persona} = req.body ?? {};
  let next: Persona;
  if (typeof from === 'string') {
    const src = findPersona(from);
    if (!src) return res.status(404).json({error: `複製元の人格がありません: ${from}`});
    const pid = PersonaIdSchema.safeParse(id);
    if (!pid.success) return res.status(400).json({error: pid.error.issues[0]?.message ?? 'id が不正'});
    next = {...src, id: pid.data, label: typeof label === 'string' && label.trim() ? label.trim() : `${src.label}（コピー）`};
  } else {
    const parsed = PersonaSchema.safeParse(persona);
    if (!parsed.success) return res.status(400).json({error: '検証に失敗', issues: parsed.error.issues.slice(0, 20)});
    next = parsed.data;
  }
  if (findPersona(next.id)) return res.status(409).json({error: `その id は既にあります: ${next.id}`});
  try {
    savePersonas([...listPersonas(), next]);
  } catch (e) {
    return res.status(400).json({error: (e as Error).message});
  }
  res.json({...listView(), persona: next});
});

/** id は変えられない（案件の brief.json が参照している） */
personasRouter.put('/:id', (req, res) => {
  const cur = findPersona(req.params.id);
  if (!cur) return res.status(404).json({error: `人格がありません: ${req.params.id}`});
  const parsed = PersonaSchema.safeParse({...(req.body ?? {}), id: cur.id});
  if (!parsed.success) return res.status(400).json({error: '検証に失敗', issues: parsed.error.issues.slice(0, 20)});
  try {
    savePersonas(listPersonas().map((p) => (p.id === cur.id ? parsed.data : p)));
  } catch (e) {
    return res.status(400).json({error: (e as Error).message});
  }
  res.json({...listView(), persona: parsed.data});
});

/** 案件が使っている人格は force=1 が無いと消さない。最後の 1 件は消せない */
personasRouter.delete('/:id', (req, res) => {
  const cur = findPersona(req.params.id);
  if (!cur) return res.status(404).json({error: `人格がありません: ${req.params.id}`});
  if (listPersonas().length <= 1) return res.status(409).json({error: '最後の 1 件は消せません（先に別の人格を追加してください）'});
  const force = req.query.force === '1' || req.query.force === 'true';
  const using = listProjects()
    .filter((p) => p.persona === cur.id)
    .map((p) => p.slug);
  if (using.length && !force) return res.status(409).json({error: `この人格を使っている案件があります: ${using.join(', ')}`, projects: using});
  try {
    savePersonas(listPersonas().filter((p) => p.id !== cur.id));
  } catch (e) {
    return res.status(400).json({error: (e as Error).message});
  }
  res.json(listView());
});
