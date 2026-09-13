import {describe, expect, it} from 'vitest';
import {TIME_ZONE, fileStamp, localDate, localDateTime, localTime} from '@shared/time';

// UTC で 2026-09-13T08:47:31Z = JST で同日 17:47:31
const ISO = '2026-09-13T08:47:31.123Z';
// UTC で 2026-09-12T23:10:00Z = JST では翌日 08:10（日付がまたぐ側）
const ISO_NEXT_DAY = '2026-09-12T23:10:00.000Z';

describe('time', () => {
  it('日本時間で表示する', () => {
    expect(TIME_ZONE).toBe('Asia/Tokyo');
    expect(localDate(ISO)).toBe('2026-09-13');
    expect(localTime(ISO)).toBe('17:47:31');
    expect(localTime(ISO, false)).toBe('17:47');
    expect(localDateTime(ISO)).toBe('2026-09-13 17:47');
    expect(localDateTime(ISO, true)).toBe('2026-09-13 17:47:31');
  });

  it('UTC のままだと前日になる時刻を翌日として扱う', () => {
    expect(localDate(ISO_NEXT_DAY)).toBe('2026-09-13');
    expect(localTime(ISO_NEXT_DAY)).toBe('08:10:00');
  });

  it('ファイル名スタンプは辞書順＝時系列順', () => {
    expect(fileStamp(ISO)).toBe('20260913-174731');
    expect(fileStamp(ISO_NEXT_DAY) < fileStamp(ISO)).toBe(true);
  });

  it('壊れた入力でも表示側を落とさない', () => {
    expect(localDate(undefined)).toBe('');
    expect(localTime('not a date')).toBe('');
    expect(localDateTime('')).toBe('');
    expect(fileStamp('not a date')).toMatch(/^\d{8}-\d{6}$/); // 現在時刻にフォールバック
  });

  it('OS のタイムゾーン設定に左右されない', () => {
    const tz = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      expect(localTime(ISO)).toBe('17:47:31');
    } finally {
      process.env.TZ = tz;
    }
  });
});
