import {beforeEach, expect, it, vi} from 'vitest';
const state = vi.hoisted(() => ({rows: new Map<string, any>(), failOn: '', transactions: 0, rollbacks: 0}));
vi.mock('../cloud/db/client', async () => {
  const {PgDialect} = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();
  const select = () => ({from: () => ({where: (condition: any) => {
    const params = dialect.sqlToQuery(condition).params;
    return {for: async () => [...state.rows.values()], limit: async () => {
      const row = state.rows.get(String(params.at(-1))); return row ? [row] : [];
    }};
  }})});
  const tx = {
    select,
    execute: async (query: any) => {
      const parsed = dialect.sqlToQuery(query);
      if (!parsed.sql.includes('INSERT INTO docs')) return [];
      const [, name, json, hash, actor] = parsed.params;
      if (name === state.failOn) throw new Error('simulated database write failure');
      const old = state.rows.get(String(name));
      state.rows.set(String(name), {name, data: JSON.parse(String(json)), hash, rev: (old?.rev ?? 0) + 1, updatedBy: actor, updatedAt: new Date()});
      return [];
    },
    update: () => ({set: () => ({where: async () => {}})}),
  };
  const client = {...tx, transaction: async (fn: (t: any) => unknown) => {
    state.transactions++;
    const snapshot = structuredClone(state.rows);
    try {return await fn(tx);} catch (e) {state.rows = snapshot; state.rollbacks++; throw e;}
  }};
  return {db: () => client, rowsOf: (v: unknown) => Array.isArray(v) ? v : []};
});
import {writeDoc} from '../cloud/store';
import {createReelCut} from '../shared/reel-cuts';
beforeEach(() => {state.rows.clear(); state.failOn = ''; state.transactions = 0; state.rollbacks = 0;});
const input = () => [createReelCut('uploads/dish.mp4', undefined, {line: 'お肉の旨みがすごいです'})];

it('共通JSONと編集・音声・台本を一括保存し、保存後もIDとハッシュが一致する', async () => {
  const result = await writeDoc('shop-reel', 'reelCuts', input(), {by: 'cloud'});
  expect(result.ok).toBe(true); expect(state.transactions).toBe(1);
  expect([...state.rows.keys()]).toEqual(['reelCuts', 'cuts', 'narration', 'script']);
  const id = state.rows.get('reelCuts').data[0].id;
  expect(id).toMatch(/^[a-f0-9-]+$/);
  expect(state.rows.get('cuts').data.cuts[0].id).toBe(id);
  expect(state.rows.get('narration').data.segments[0].id).toBe(`oc_${id}`);
  expect(state.rows.get('script').data.text).toContain(`reel-cut:${id}`);
  expect(result.ok && result.hash).toBe(state.rows.get('reelCuts').hash);
  expect(result.ok && result.relatedEtags?.narration).toEqual({before: null, after: `1-${state.rows.get('narration').hash}`});
});
it('クラウドの既存編集APIでカットを追加しても共通JSONと音声に同じ固定IDを付ける', async () => {
  await writeDoc('shop-reel', 'reelCuts', input(), {by: 'cloud'});
  const editor = structuredClone(state.rows.get('cuts').data);
  editor.cuts.push({src: 'uploads/second.mp4', inSec: 0, outSec: 2});
  const r = await writeDoc('shop-reel', 'cuts', editor, {by: 'cloud', expectRev: 1});
  expect(r.ok).toBe(true);
  const saved = state.rows.get('reelCuts').data;
  expect(saved).toHaveLength(2); expect(saved[1].id).toBeTruthy();
  expect(state.rows.get('cuts').data.cuts[1].id).toBe(saved[1].id);
});
it('古い版からの保存は上書きせず競合を返す', async () => {
  await writeDoc('shop-reel', 'reelCuts', input(), {by: 'cloud'});
  await writeDoc('shop-reel', 'reelCuts', input(), {by: 'cloud', expectRev: 1});
  const snapshot = structuredClone(state.rows);
  const r = await writeDoc('shop-reel', 'reelCuts', input(), {by: 'cloud', expectRev: 1});
  expect(r.ok).toBe(false); expect(state.rows).toEqual(snapshot);
});
it('一部の書き込みが失敗したら原本も互換ドキュメントもロールバックする', async () => {
  await writeDoc('shop-reel', 'reelCuts', input(), {by: 'cloud'});
  const snapshot = structuredClone(state.rows); state.failOn = 'narration';
  await expect(writeDoc('shop-reel', 'reelCuts', input(), {by: 'cloud'})).rejects.toThrow('simulated');
  expect(state.rows).toEqual(snapshot); expect(state.rollbacks).toBe(1);
});
