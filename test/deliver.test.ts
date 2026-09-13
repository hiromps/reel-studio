import {describe, expect, it} from 'vitest';
import {DELIVER_LABEL, deliverFileName, deliverSource, safeFileName} from '@shared/deliver';

describe('safeFileName', () => {
  it('Windows で使えない文字を落とす', () => {
    expect(safeFileName('焼肉/こじま:離れ?')).toBe('焼肉こじま離れ');
  });

  it('前後の空白とドットを落とし、連続空白は 1 つにする', () => {
    expect(safeFileName('  bonjour   arima. ')).toBe('bonjour arima');
  });

  it('店名そのものは変えない（勝手に短縮・変換しない）', () => {
    expect(safeFileName('うんこちゃんの家具屋さん')).toBe('うんこちゃんの家具屋さん');
  });
});

describe('deliverFileName', () => {
  it('名前だけでナレーションの有無が分かる', () => {
    expect(deliverFileName({shop: '活魚センター', persona: 'hiro', kind: 'narration'})).toBe('活魚センター_hiro_ナレーション付き.mp4');
    expect(deliverFileName({shop: '活魚センター', persona: 'hiro', kind: 'silent'})).toBe('活魚センター_hiro_ナレーションなし.mp4');
  });

  it('キャプションは txt', () => {
    expect(deliverFileName({shop: '活魚センター', persona: 'nagi', kind: 'caption'})).toBe('活魚センター_nagi_caption.txt');
  });

  it('label は人格とナレーション有無の後に付く', () => {
    expect(deliverFileName({shop: 'ドミノピザ', persona: 'sayuri', kind: 'narration', label: '修正版'})).toBe('ドミノピザ_sayuri_ナレーション付き_修正版.mp4');
  });

  it('v1 には版番号を付けず、v2 以降だけ付ける（既存を上書きしないため）', () => {
    const base = {shop: 'musch', persona: 'hiro', kind: 'narration'} as const;
    expect(deliverFileName({...base, version: 1})).toBe('musch_hiro_ナレーション付き.mp4');
    expect(deliverFileName({...base, version: 3})).toBe('musch_hiro_ナレーション付き_v3.mp4');
  });

  it('店名が空でも壊れない', () => {
    expect(deliverFileName({shop: '   ', persona: 'hiro', kind: 'narration'})).toBe('案件_hiro_ナレーション付き.mp4');
  });
});

describe('deliverSource', () => {
  it('完成品はナレーション合成後の mp4（音声なしは別扱い）', () => {
    expect(deliverSource('narration')).toBe('out/final_narration.mp4');
    expect(deliverSource('silent')).toBe('out/final.mp4');
    expect(deliverSource('caption')).toBe('caption.txt');
  });

  it('draft は納品対象に無い', () => {
    expect(Object.keys(DELIVER_LABEL)).toEqual(['narration', 'silent', 'caption']);
  });
});
