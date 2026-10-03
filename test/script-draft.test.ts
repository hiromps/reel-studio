import {describe, expect, it} from 'vitest';
import {ScriptDraftSchema, checkScriptDraft, renderScriptDraft, tidyDraft} from '../shared/script-draft';
import {parseSections} from '../shared/script';

const draft = () =>
  ScriptDraftSchema.parse({
    sections: [
      {fromSec: 0, toSec: 2.2, label: 'フック', video: 'カニ桶を持ち上げる（id 51）→ 身をつゆに浸ける（id 36）', cutCount: 3, cutSec: '0.7〜0.8', telop: '9割が知らない最強の店・・・', badge: '三宮', orientation: 'vertical', narration: 'これ、きゅうわりが知らない最強の店かも', why: '煽り'},
      {fromSec: 2.4, toSec: 5.4, label: '本題', video: '寿司の盛り合わせ（id 10）', cutCount: 4, cutSec: '0.7〜0.8', telop: '本ずわい蟹が食べ放題', badge: '', orientation: 'vertical', narration: 'ほんずわいがにが食べ放題', why: ''},
    ],
    notes: 'カニ推し',
    unmatched: ['店の外観'],
  });

describe('依頼文から書いた台本', () => {
  it('区間の隙間を詰め、先頭を 0 秒にする（長さは保つ）', () => {
    const {plan, fixes} = tidyDraft(draft());
    expect(plan.sections.map((s) => [s.fromSec, s.toSec])).toEqual([
      [0, 2.2],
      [2.2, 5.2],
    ]);
    expect(fixes).toHaveLength(1);
  });

  it('script.md に書き出すと「台本から組み立てる」が区間を読める', () => {
    const {plan} = tidyDraft(draft());
    const md = renderScriptDraft(plan, {request: 'カニ蔵を 20 秒で\nテンポ速め', shopName: 'かに蔵'});
    expect(md).toContain('# 依頼: カニ蔵を 20 秒で');
    expect(md).toContain('バッジ： 三宮');
    expect(md).toContain('# - 店の外観');
    const sections = parseSections(md);
    expect(sections.map((s) => [s.fromSec, s.toSec, s.label])).toEqual([
      [0, 2.2, 'フック'],
      [2.2, 5.2, '本題'],
    ]);
  });

  it('区間が無ければ E、テロップの長さ・三点リーダー・尺のずれは W', () => {
    expect(checkScriptDraft(ScriptDraftSchema.parse({sections: []})).map((i) => i.code)).toEqual(['DRAFT_NO_SECTIONS']);
    const p = draft();
    p.sections[1].telop = 'とても長いテロップで十三文字を超えてしまう…';
    const codes = checkScriptDraft(tidyDraft(p).plan, {targetSec: 20, maxTelopChars: 13}).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['DRAFT_TELOP_LONG', 'DRAFT_TELOP_ELLIPSIS', 'DRAFT_TOTAL']));
    expect(codes.some((c) => c.startsWith('DRAFT_BAD'))).toBe(false);
  });
});
