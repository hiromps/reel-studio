// 選別モードで素材を編集する部分。ここは catalog.json に直接書き込む操作なので、
// 「掴んだら意図した区間になる」「他の区間を壊さない」を固めておく。
import {describe, expect, it} from 'vitest';
import {makeClip} from './helpers';
import {primaryRange, primaryRangeIndex, rangeForBar, withRange, withRangeLabel, withTags, withoutPrimaryRange} from '../src/components/triage';
import type {Clip} from '@shared/schema';

const clip = (ranges: Clip['usableRanges'] = [], dur = 6): Clip => ({...makeClip({id: '01', slug: 'tea-pour', dur, kind: 'sizzle'}), usableRanges: ranges});

describe('選別モードの使える区間', () => {
  it('区間が無ければ全尺を帯に出す（掴んだ瞬間に区間になる）', () => {
    expect(rangeForBar(clip())).toEqual({inSec: 0, outSec: 6});
    expect(primaryRangeIndex(clip())).toBe(-1);
  });

  it('区間が無い状態で掴むと best として作られる', () => {
    const next = withRange(clip(), {inSec: 1.5, outSec: 3.25});
    expect(next.usableRanges).toEqual([{inSec: 1.5, outSec: 3.25, label: 'best'}]);
  });

  it('既にある区間は上書きし、メモや扱いは残す', () => {
    const c = clip([{inSec: 1, outSec: 2, label: 'ok', note: '湯気'}]);
    const next = withRange(c, {inSec: 1.2, outSec: 4});
    expect(next.usableRanges).toEqual([{inSec: 1.2, outSec: 4, label: 'ok', note: '湯気'}]);
  });

  it('avoid（使わない区間）は掴む対象にしない。その手前に best を作る', () => {
    const c = clip([{inSec: 0, outSec: 1, label: 'avoid'}]);
    expect(primaryRangeIndex(c)).toBe(-1);
    const next = withRange(c, {inSec: 2, outSec: 3});
    expect(next.usableRanges).toEqual([
      {inSec: 2, outSec: 3, label: 'best'},
      {inSec: 0, outSec: 1, label: 'avoid'},
    ]);
  });

  it('avoid が先にあっても、その後ろの区間を主区間として扱う', () => {
    const c = clip([
      {inSec: 0, outSec: 1, label: 'avoid'},
      {inSec: 2, outSec: 4, label: 'ok'},
    ]);
    expect(primaryRangeIndex(c)).toBe(1);
    expect(primaryRange(c)?.label).toBe('ok');
    const next = withRange(c, {inSec: 2.5, outSec: 5});
    // avoid の方は触らない
    expect(next.usableRanges[0]).toEqual({inSec: 0, outSec: 1, label: 'avoid'});
    expect(next.usableRanges[1]).toEqual({inSec: 2.5, outSec: 5, label: 'ok'});
  });

  it('扱い（label）だけを変えられる。無いときは今の範囲で作る', () => {
    const c = clip([{inSec: 1, outSec: 2, label: 'ok'}]);
    expect(withRangeLabel(c, 'best', {inSec: 0, outSec: 6}).usableRanges[0]).toEqual({inSec: 1, outSec: 2, label: 'best'});
    expect(withRangeLabel(clip(), 'motion-full', {inSec: 0, outSec: 6}).usableRanges).toEqual([{inSec: 0, outSec: 6, label: 'motion-full'}]);
  });

  it('区間を消すと全尺から使う状態に戻る（avoid は残す）', () => {
    const c = clip([
      {inSec: 0, outSec: 1, label: 'avoid'},
      {inSec: 2, outSec: 4, label: 'best'},
    ]);
    const next = withoutPrimaryRange(c);
    expect(next.usableRanges).toEqual([{inSec: 0, outSec: 1, label: 'avoid'}]);
    expect(rangeForBar(next)).toEqual({inSec: 0, outSec: 6});
  });

  it('素材の尺を超える区間は帯の上では尺までに収める（壊れた catalog でも帯が破綻しない）', () => {
    const c = clip([{inSec: 1, outSec: 99, label: 'best'}], 6);
    expect(rangeForBar(c)).toEqual({inSec: 1, outSec: 6});
  });
});

describe('選別モードのタグ編集', () => {
  it('未タグのクリップにも書ける（既定値を敷いてから当てる）', () => {
    const c = {...clip(), tags: undefined} as Clip;
    const next = withTags(c, {kind: 'eating'}, '2026-01-01T00:00:00.000Z');
    expect(next.tags).toMatchObject({kind: 'eating', angle: 'mid', source: 'user', taggedAt: '2026-01-01T00:00:00.000Z', description: 'tea-pour'});
  });

  it('既にあるタグは指定した項目だけ変える', () => {
    const c = clip();
    const next = withTags(c, {angle: 'close'}, '2026-01-01T00:00:00.000Z');
    expect(next.tags?.angle).toBe('close');
    expect(next.tags?.kind).toBe(c.tags?.kind);
    expect(next.tags?.subject).toBe(c.tags?.subject);
    // 人が触ったものとして記録する（Claude のタグ付けに上書きされないため）
    expect(next.tags?.source).toBe('user');
  });
});
