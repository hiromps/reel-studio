import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {ReelDataSchema, NarrationSchema} from '@shared/schema';
import {FORMAT_SPECS, FORMAT_IDS} from '@shared/format-specs';
import {BUILTIN_PERSONAS, PersonasFileSchema} from '@shared/personas';
import {studioConfig} from '../studio.config';

const fixtures = path.resolve(__dirname, 'fixtures');
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

describe('cuts.json スキーマ', () => {
  it('回帰フィクスチャ（meta 入り）が parse できる', () => {
    for (const f of ['2050coffee', 'musch-aki', 'katsugyocenter-nagi', 'reunion-hiro']) {
      const data = ReelDataSchema.parse(readJson(path.join(fixtures, `${f}.cuts.json`)));
      expect(data.cuts.length).toBeGreaterThan(0);
    }
  });

  it('work/*-reel/cuts.json の既存ファイルが全件 parse できる', () => {
    if (!fs.existsSync(studioConfig.workDir)) return;
    const dirs = fs.readdirSync(studioConfig.workDir).filter((d) => d.endsWith('-reel'));
    let ok = 0;
    const failed: string[] = [];
    for (const d of dirs) {
      const p = path.join(studioConfig.workDir, d, 'cuts.json');
      if (!fs.existsSync(p)) continue;
      const json = readJson(p);
      if (json?.theme === 'yui') continue; // yui-daihon は別エンジン（対象外）
      const r = ReelDataSchema.safeParse(json);
      if (r.success) ok++;
      else failed.push(`${d}: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`);
    }
    expect(failed, failed.join('\n')).toEqual([]);
    expect(ok).toBeGreaterThan(0);
  });

  it('narration.json が parse できる', () => {
    const n = NarrationSchema.parse(readJson(path.join(fixtures, 'musch-aki.narration.json')));
    expect(n.segments.length).toBe(13);
  });
});

describe('format-specs', () => {
  it('F0〜F7 が揃い、区間の timeSec が連続している', () => {
    expect(FORMAT_IDS).toEqual(['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']);
    for (const id of FORMAT_IDS) {
      const spec = FORMAT_SPECS[id];
      expect(spec.segments[0].timeSec[0]).toBe(0);
      for (let i = 1; i < spec.segments.length; i++) {
        expect(spec.segments[i].timeSec[0], `${id} ${spec.segments[i].id}`).toBe(spec.segments[i - 1].timeSec[1]);
      }
      expect(spec.segments[spec.segments.length - 1].timeSec[1]).toBe(spec.nominalSec);
      expect(spec.nominalSec).toBeLessThanOrEqual(spec.maxSec);
      expect(spec.targetSec[1]).toBeLessThanOrEqual(spec.maxSec);
      for (const s of spec.segments) {
        expect(s.cutSec[0]).toBeLessThanOrEqual(s.cutSec[1]);
        expect(s.cuts[0]).toBeLessThanOrEqual(s.cuts[1]);
        expect(s.cutSec[1]).toBeLessThanOrEqual(spec.tempo.maxCutSec);
      }
      if (spec.repeat) expect(spec.segments.some((s) => s.id === spec.repeat!.segmentId)).toBe(true);
      if (spec.reveal === 'late') expect(spec.revealPct).toBeDefined();
    }
  });
});

describe('personas（同梱のサンプル）', () => {
  it('id が重複せず、既定フォーマットが spec に存在する', () => {
    const ids = BUILTIN_PERSONAS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of BUILTIN_PERSONAS) expect(FORMAT_SPECS[p.defaultFormat]).toBeDefined();
    expect(BUILTIN_PERSONAS.find((p) => p.id === 'discovery')?.defaultFormat).toBe('F7');
  });

  it('サンプルはボイス未設定で配る（利用者が自分の Fish Audio モデルを入れる）。空は許すが 32 桁以外は弾く', () => {
    // 空を許すのは、使っていたボイスが Fish Audio から消えたときに
    // **黙って別の声に差し替えない**ため（音声生成が「未設定です」で止まる）
    for (const p of BUILTIN_PERSONAS) expect(p.narration.voiceId, p.id).toBe('');
    expect(PersonasFileSchema.safeParse({version: 1, personas: [{...BUILTIN_PERSONAS[0], narration: {...BUILTIN_PERSONAS[0].narration, voiceId: 'xyz'}}]}).success).toBe(false);
  });

  it('personas.json は id の重複と 0 件を弾く', () => {
    expect(PersonasFileSchema.safeParse({version: 1, personas: []}).success).toBe(false);
    expect(PersonasFileSchema.safeParse({version: 1, personas: [BUILTIN_PERSONAS[0], BUILTIN_PERSONAS[0]]}).success).toBe(false);
    expect(PersonasFileSchema.safeParse({version: 1, personas: BUILTIN_PERSONAS}).success).toBe(true);
  });
});
