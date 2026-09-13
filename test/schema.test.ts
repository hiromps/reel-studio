import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {ReelDataSchema, NarrationSchema} from '@shared/schema';
import {FORMAT_SPECS, FORMAT_IDS} from '@shared/format-specs';
import {PERSONAS} from '@shared/personas';
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

describe('personas', () => {
  it('4 人格の既定フォーマットが spec に存在する', () => {
    for (const p of Object.values(PERSONAS)) expect(FORMAT_SPECS[p.defaultFormat]).toBeDefined();
    expect(PERSONAS.nagi.defaultFormat).toBe('F7');
    expect(PERSONAS.hiro.narration.charsPerSec).toBe(11.0);
  });

  it('voiceId は 32 桁の id か、空（ボイス未定）のどちらか', () => {
    // 空を許すのは、使っていたボイスが Fish Audio から消えたときに
    // **黙って別の声に差し替えない**ため（音声生成が「未設定です」で止まる）
    for (const p of Object.values(PERSONAS)) expect(p.narration.voiceId, p.id).toMatch(/^(|[0-9a-f]{32})$/);
  });

  it('ボイスが決まっている人格は id が入っている', () => {
    for (const id of ['hiro', 'nagi', 'bonjiri'] as const) expect(PERSONAS[id].narration.voiceId, id).toMatch(/^[0-9a-f]{32}$/);
  });
});
