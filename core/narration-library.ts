import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {NarrationLibrarySchema, type NarrationLibraryEntry} from '../shared/narration-library';
import {NarrationSegmentSchema, type Narration} from '../shared/schema';
import {settingsDir} from './settings';
import {resolveProjectDirStrict} from './project';
import {readJsonLoose, writeJsonAtomic} from './json-io';

const dir = (): string => path.join(settingsDir(), 'narration-library');
const indexPath = (): string => path.join(dir(), 'index.json');
const audioPath = (id: string): string => path.join(dir(), `${id}.wav`);

export const listNarrationLibrary = (): NarrationLibraryEntry[] => {
  try {
    return NarrationLibrarySchema.parse(readJsonLoose(indexPath())).entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
};

export const narrationLibraryAudio = (id: string): string | null => {
  const entry = listNarrationLibrary().find((x) => x.id === id);
  const file = entry ? audioPath(entry.id) : null;
  return file && fs.existsSync(file) ? file : null;
};

export const saveNarrationToLibrary = (body: {project: string; segment: unknown; narration: Pick<Narration, 'voice' | 'voiceTitle' | 'speed' | 'latency'>; title: string}): NarrationLibraryEntry => {
  const segment = NarrationSegmentSchema.parse(body.segment);
  const title = body.title.trim();
  if (!title || title.length > 80) throw new Error('保存名は 1〜80 文字にしてください');
  if (!segment.text.trim() || !segment.durSec || (segment as {needsTts?: boolean}).needsTts) throw new Error('生成済みのナレーション音声を選んでください');
  if (!/^[a-zA-Z0-9_-]+$/.test(segment.id)) throw new Error('音声 ID が不正です');
  const source = path.join(resolveProjectDirStrict(body.project), 'narration', `${segment.id}.wav`);
  if (!fs.existsSync(source)) throw new Error('生成済みの音声ファイルが見つかりません');
  const entry = NarrationLibrarySchema.shape.entries.element.parse({
    id: randomUUID(), title, text: segment.text, voice: body.narration.voice,
    voiceTitle: body.narration.voiceTitle, speed: body.narration.speed, latency: body.narration.latency,
    durSec: segment.durSec, trimSec: segment.trimSec, createdAt: new Date().toISOString(),
  });
  fs.mkdirSync(dir(), {recursive: true});
  fs.copyFileSync(source, audioPath(entry.id), fs.constants.COPYFILE_EXCL);
  try {
    writeJsonAtomic(indexPath(), {version: 1, entries: [entry, ...listNarrationLibrary()]});
  } catch (error) {
    fs.rmSync(audioPath(entry.id), {force: true});
    throw error;
  }
  return entry;
};

export const useNarrationFromLibrary = (id: string, project: string, segmentId: string): NarrationLibraryEntry => {
  const entry = listNarrationLibrary().find((x) => x.id === id);
  if (!entry) throw new Error('保存した音声が見つかりません');
  if (!/^[a-zA-Z0-9_-]+$/.test(segmentId)) throw new Error('音声 ID が不正です');
  const source = narrationLibraryAudio(id);
  if (!source) throw new Error('保存した音声ファイルが見つかりません');
  const target = path.join(resolveProjectDirStrict(project), 'narration');
  fs.mkdirSync(target, {recursive: true});
  fs.copyFileSync(source, path.join(target, `${segmentId}.wav`), fs.constants.COPYFILE_EXCL);
  return entry;
};

export const deleteNarrationFromLibrary = (id: string): boolean => {
  const entries = listNarrationLibrary();
  if (!entries.some((x) => x.id === id)) return false;
  writeJsonAtomic(indexPath(), {version: 1, entries: entries.filter((x) => x.id !== id)});
  fs.rmSync(audioPath(id), {force: true});
  return true;
};
