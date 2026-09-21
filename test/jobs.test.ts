import {describe, expect, it} from 'vitest';
import {HEAVY_JOBS, JOB_TYPES, canStartJob, isHeavyJob} from '@shared/jobs';

const j = (slug: string, type: string) => ({slug, type});

describe('canStartJob', () => {
  it('案件が違えば同時に走らせる（複数案件の並行作業）', () => {
    expect(canStartJob(j('b-reel', 'ai-telop'), [j('a-reel', 'ai-tag')], 2)).toBe(true);
  });

  it('同じ案件では 2 本走らせない（契約ファイルを取り合うため）', () => {
    expect(canStartJob(j('a-reel', 'ai-telop'), [j('a-reel', 'ai-tag')], 4)).toBe(false);
  });

  it('重いジョブは案件が違っても 1 本だけ', () => {
    expect(canStartJob(j('b-reel', 'render'), [j('a-reel', 'draft')], 4)).toBe(false);
    // 軽いジョブなら重いジョブと同時でよい
    expect(canStartJob(j('b-reel', 'ai-caption'), [j('a-reel', 'render')], 4)).toBe(true);
    expect(canStartJob(j('b-reel', 'render'), [j('a-reel', 'ai-caption')], 4)).toBe(true);
  });

  it('全体の上限を超えたら待たせる', () => {
    expect(canStartJob(j('c-reel', 'tts'), [j('a-reel', 'ai-tag'), j('b-reel', 'ai-telop')], 2)).toBe(false);
    expect(canStartJob(j('c-reel', 'tts'), [j('a-reel', 'ai-tag'), j('b-reel', 'ai-telop')], 3)).toBe(true);
  });

  it('何も走っていなければ必ず始められる', () => {
    for (const t of JOB_TYPES) expect(canStartJob(j('a-reel', t), [], 2)).toBe(true);
  });

  // 「最新に」ボタンが積む同期。押してすぐ走ってほしいので軽いジョブ扱いにしてある
  it('同期（sync）は軽いジョブで、他案件のレンダー中でも走る', () => {
    expect(JOB_TYPES).toContain('sync');
    expect(isHeavyJob('sync')).toBe(false);
    expect(canStartJob(j('b-reel', 'sync'), [j('a-reel', 'render')], 2)).toBe(true);
    // 同じ案件で何か走っているときは待つ（契約ファイルを取り合わない）
    expect(canStartJob(j('a-reel', 'sync'), [j('a-reel', 'render')], 2)).toBe(false);
  });
});

describe('HEAVY_JOBS', () => {
  it('ffmpeg / Remotion を回すものだけが重い', () => {
    expect(isHeavyJob('render')).toBe(true);
    expect(isHeavyJob('catalog')).toBe(true);
    expect(isHeavyJob('mix')).toBe(true);
    expect(isHeavyJob('ai-tag')).toBe(false);
    expect(isHeavyJob('tts')).toBe(false);
    // 一覧に無い種別を重い扱いにしない
    expect(isHeavyJob('unknown')).toBe(false);
  });

  it('HEAVY_JOBS はすべて JOB_TYPES に含まれる（綴り間違いの検出）', () => {
    for (const t of HEAVY_JOBS) expect(JOB_TYPES).toContain(t);
  });
});
