import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deleteNarrationFromLibrary, listNarrationLibrary, narrationLibraryAudio, saveNarrationToLibrary, useNarrationFromLibrary} from '../core/narration-library';

let root: string;
const oldHome = process.env.REEL_STUDIO_HOME;
const oldWorkDir = process.env.REEL_STUDIO_WORK_DIR;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-narr-lib-'));
  process.env.REEL_STUDIO_HOME = path.join(root, 'settings');
  process.env.REEL_STUDIO_WORK_DIR = path.join(root, 'work');
  fs.mkdirSync(path.join(root, 'work', 'source-reel', 'narration'), {recursive: true});
  fs.mkdirSync(path.join(root, 'work', 'target-reel'), {recursive: true});
  fs.writeFileSync(path.join(root, 'work', 'source-reel', 'narration', 'opening.wav'), 'favorite-voice');
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.REEL_STUDIO_HOME;
  else process.env.REEL_STUDIO_HOME = oldHome;
  if (oldWorkDir === undefined) delete process.env.REEL_STUDIO_WORK_DIR;
  else process.env.REEL_STUDIO_WORK_DIR = oldWorkDir;
  fs.rmSync(root, {recursive: true, force: true});
});

describe('ナレーション音声ライブラリ', () => {
  it('音声を独立して保存し、元案件の WAV を消しても別案件へ使える', () => {
    const entry = saveNarrationToLibrary({project: 'source-reel', segment: {id: 'opening', text: 'いつもの始まりです', at: 0, durSec: 1.4}, narration: {voice: 'favorite-voice', speed: 1.1}, title: '冒頭の決まり文句'});
    expect(listNarrationLibrary()[0]).toMatchObject({id: entry.id, title: '冒頭の決まり文句', text: 'いつもの始まりです', voice: 'favorite-voice'});
    fs.rmSync(path.join(root, 'work', 'source-reel', 'narration', 'opening.wav'));
    useNarrationFromLibrary(entry.id, 'target-reel', 'saved_01');
    expect(fs.readFileSync(path.join(root, 'work', 'target-reel', 'narration', 'saved_01.wav'), 'utf8')).toBe('favorite-voice');
    expect(deleteNarrationFromLibrary(entry.id)).toBe(true);
    expect(narrationLibraryAudio(entry.id)).toBeNull();
    expect(fs.readFileSync(path.join(root, 'work', 'target-reel', 'narration', 'saved_01.wav'), 'utf8')).toBe('favorite-voice');
  });

  it('要再生成の音声は保存しない', () => {
    expect(() => saveNarrationToLibrary({project: 'source-reel', segment: {id: 'opening', text: '変更した文言', at: 0, durSec: 1.4, needsTts: true}, narration: {voice: 'favorite-voice'}, title: '変更後'})).toThrow('生成済み');
    expect(listNarrationLibrary()).toEqual([]);
  });
  it('使用する長さも保存して別案件へ引き継げる', () => {
    const entry = saveNarrationToLibrary({project: 'source-reel', segment: {id: 'opening', text: '前半だけ', at: 0, durSec: 2, trimSec: 0.8}, narration: {voice: 'favorite-voice'}, title: '前半'});
    expect(entry.trimSec).toBe(0.8);
    expect(listNarrationLibrary()[0].trimSec).toBe(0.8);
    expect(useNarrationFromLibrary(entry.id, 'target-reel', 'saved_01').trimSec).toBe(0.8);
  });
});
