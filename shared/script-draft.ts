// 依頼文から書いた台本（純粋）。AI の返答を検算して、script.md の形に書き出す。
// AI を走らせるのは core/script-draft.ts。書き出した script.md は「台本から組み立てる」がそのまま読める。
import {MimicPlanSchema, renderScriptSections, type MimicPlan} from './reference';

/** 依頼文から書く台本の返答（型を写す台本と同じ形。区間・映像・カット割り・テロップ・ナレーション） */
export const ScriptDraftSchema = MimicPlanSchema;
export type ScriptDraft = MimicPlan;

export type ScriptDraftIssue = {severity: 'E' | 'W'; code: string; message: string};

const r2 = (n: number) => Math.round(n * 100) / 100;
const chars = (s: string) => [...s].length;

/**
 * 区間を時刻順に並べ、隙間と重なりを詰める（AI は区間の境目を少しずらして書きがち）。
 * 先頭は 0 秒から。区間の長さは保つ
 */
export const tidyDraft = (plan: ScriptDraft): {plan: ScriptDraft; fixes: string[]} => {
  const fixes: string[] = [];
  const sorted = [...plan.sections].filter((s) => s.toSec > s.fromSec).sort((a, b) => a.fromSec - b.fromSec);
  let t = 0;
  const sections = sorted.map((s, i) => {
    const len = s.toSec - s.fromSec;
    if (Math.abs(s.fromSec - t) > 0.05) fixes.push(`区間${i + 1}（${s.label || '-'}）の開始を ${r2(s.fromSec)} 秒から ${r2(t)} 秒に詰めました`);
    const next = {...s, fromSec: r2(t), toSec: r2(t + len)};
    t = next.toSec;
    return next;
  });
  return {plan: {...plan, sections}, fixes};
};

/** 検算。E があれば script.md を書かない */
export const checkScriptDraft = (plan: ScriptDraft, opt: {targetSec?: number; maxTelopChars?: number} = {}): ScriptDraftIssue[] => {
  const out: ScriptDraftIssue[] = [];
  const max = opt.maxTelopChars ?? 13;
  if (!plan.sections.length) return [{severity: 'E', code: 'DRAFT_NO_SECTIONS', message: '区間が 1 つも返ってきませんでした'}];
  plan.sections.forEach((s, i) => {
    const label = `[${i + 1}] ${s.label || `${s.fromSec}〜${s.toSec}秒`}`;
    if (s.toSec <= s.fromSec) out.push({severity: 'E', code: 'DRAFT_BAD_RANGE', message: `${label}: 区間が逆または 0（${s.fromSec}〜${s.toSec}）`});
    const t = s.telop.trim();
    if (t && chars(t) > max) out.push({severity: 'W', code: 'DRAFT_TELOP_LONG', message: `${label}: テロップが ${chars(t)} 文字（目安 ${max}）「${t}」`});
    if (/[。]$/.test(t)) out.push({severity: 'W', code: 'DRAFT_TELOP_PERIOD', message: `${label}: テロップの文末に句点は付けない`});
    if (/…/.test(t)) out.push({severity: 'W', code: 'DRAFT_TELOP_ELLIPSIS', message: `${label}: 三点リーダーは全角 3 文字の「・・・」で書く`});
    if (!s.video.trim()) out.push({severity: 'W', code: 'DRAFT_VIDEO_EMPTY', message: `${label}: 映像の指示がありません`});
  });
  const total = plan.sections.reduce((n, s) => Math.max(n, s.toSec), 0);
  if (opt.targetSec && Math.abs(total - opt.targetSec) > Math.max(3, opt.targetSec * 0.25))
    out.push({severity: 'W', code: 'DRAFT_TOTAL', message: `全体が ${r2(total)} 秒（目安 ${opt.targetSec} 秒）`});
  if (!plan.sections.some((s) => s.narration.trim())) out.push({severity: 'W', code: 'DRAFT_NO_NARRATION', message: 'ナレーションが 1 つもありません'});
  return out;
};

/** script.md に書き出す。先頭のコメント行は「台本から組み立てる」の AI が意図を掴むためのもの */
export const renderScriptDraft = (plan: ScriptDraft, opt: {request: string; shopName?: string}): string => {
  const req = opt.request
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const head = [
    `# 依頼文から書いた台本${opt.shopName ? `（${opt.shopName}）` : ''}`,
    ...req.slice(0, 12).map((l, i) => `# ${i === 0 ? '依頼: ' : '　　 '}${l}`),
    req.length > 12 ? '# 　　 （以下略）' : '',
    plan.notes ? `# 意図: ${plan.notes.replace(/\s*\n\s*/g, ' ')}` : '',
  ].filter(Boolean);
  const tail = plan.unmatched.length ? ['', '# 台本にあるが手元の素材に無いもの（撮り足しの候補）', ...plan.unmatched.map((u) => `# - ${u}`)] : [];
  return [...head, '', renderScriptSections(plan.sections), ...tail].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
};
