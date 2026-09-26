// 納品：案件フォルダの完成物を outputs/ に名前を付けて書き出す。
//
// 出すのは**完成品だけ**（ナレーション付き mp4 と キャプション）。draft と音声なしの mp4 は
// 作業用なので案件フォルダの out/ に置いたままにする。
// 名前だけ見て「どの店・どの人格・ナレーションの有無」が分かるようにする。
import fs from 'node:fs';
import path from 'node:path';
import {readBrief, readCaption, readNarration} from './project';
import {studioConfig} from '../studio.config';
import {DELIVER_LABEL, deliverFileName, deliverSource, type DeliverKind} from '../shared/deliver';
import {getPersona} from '../shared/personas';

export type DeliverItem = {kind: DeliverKind; from: string; to: string; bytes: number; skipped?: 'same'};

export type DeliverResult = {items: DeliverItem[]; outputsDir: string; warnings: string[]};

const sameFile = (a: string, b: string): boolean => {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    // 大きい動画なので全読みはしない。サイズが同じなら先頭・末尾 1MB だけ比べる
    const chunk = Math.min(1024 * 1024, sa.size);
    const read = (f: string, pos: number) => {
      const fd = fs.openSync(f, 'r');
      try {
        const buf = Buffer.alloc(chunk);
        fs.readSync(fd, buf, 0, chunk, pos);
        return buf;
      } finally {
        fs.closeSync(fd);
      }
    };
    return read(a, 0).equals(read(b, 0)) && read(a, Math.max(0, sa.size - chunk)).equals(read(b, Math.max(0, sb.size - chunk)));
  } catch {
    return false;
  }
};

/**
 * 「ナレーション付き」と名乗ってよいかを確かめる。
 * mix を忘れて素材の音だけの動画を「ナレーション付き」として納品する事故を防ぐため、
 * **名前を付ける前に必ずここを通す**。
 */
export const narrationReady = (projectDir: string): {ok: boolean; reason?: string} => {
  const mixed = path.join(projectDir, 'out', 'final_narration.mp4');
  if (!fs.existsSync(mixed)) return {ok: false, reason: 'out/final_narration.mp4 が無い（「ナレーション合成（mix）」がまだ）'};
  const narration = readNarration(projectDir);
  if (!narration?.segments.length) return {ok: false, reason: 'narration.json が無い（ナレーション原稿がまだ）'};
  const pending = narration.segments.filter((s) => (s as {needsTts?: boolean}).needsTts).map((s) => s.id);
  if (pending.length) return {ok: false, reason: `音声が未生成のブロックがある: ${pending.join(', ')}`};
  const mixedAt = fs.statSync(mixed).mtimeMs;
  const src = path.join(projectDir, 'out', 'final.mp4');
  if (fs.existsSync(src) && fs.statSync(src).mtimeMs > mixedAt) return {ok: false, reason: 'out/final.mp4 の方が新しい（レンダーし直したあと mix していない）'};
  const stale: string[] = [];
  for (const s of narration.segments) {
    const wav = path.join(projectDir, 'narration', `${s.id}.wav`);
    if (!fs.existsSync(wav)) return {ok: false, reason: `narration/${s.id}.wav が無い`};
    if (fs.statSync(wav).mtimeMs > mixedAt) stale.push(s.id);
  }
  if (stale.length) return {ok: false, reason: `音声を作り直したあと mix していない: ${stale.join(', ')}`};
  const nj = path.join(projectDir, 'narration.json');
  if (fs.existsSync(nj) && fs.statSync(nj).mtimeMs > mixedAt) return {ok: false, reason: 'narration.json を直したあと mix していない（効果音・音量の変更を含む）'};
  return {ok: true};
};

export type DeliverOptions = {
  /** ファイル名に足す任意の語（「修正版」など） */
  label?: string;
  /** ナレーションが無い案件で、音声なしの mp4 を納品してよい */
  allowSilent?: boolean;
  /** 同名があっても v2, v3… を作らず上書きする */
  overwrite?: boolean;
  onLine?: (line: string) => void;
};

/**
 * 完成品を outputs/ へ。既存と中身が同じなら何もしない。
 * 違うものが同名で既にあるときは**上書きせず** `_v2`, `_v3`… を付ける（過去の納品物を壊さない）。
 */
export const deliver = async (projectDir: string, opt: DeliverOptions = {}): Promise<DeliverResult> => {
  const log = opt.onLine ?? (() => {});
  const brief = readBrief(projectDir);
  if (!brief) throw new Error('brief.json が無いので店名と人格が分かりません');
  const persona = getPersona(brief.persona);
  const outputsDir = studioConfig.outputsDir;
  fs.mkdirSync(outputsDir, {recursive: true});
  const warnings: string[] = [];

  const kinds: DeliverKind[] = [];
  const ready = narrationReady(projectDir);
  if (ready.ok) kinds.push('narration');
  else if (opt.allowSilent && fs.existsSync(path.join(projectDir, 'out', 'final.mp4'))) {
    kinds.push('silent');
    warnings.push(`ナレーション付きを出せないので音声なしで納品します（${ready.reason}）`);
  } else {
    throw new Error(`完成品（ナレーション付き）が用意できていません: ${ready.reason}\n  ナレーションを使わない案件なら --allow-silent を付けてください`);
  }
  if (readCaption(projectDir)?.trim()) kinds.push('caption');
  else warnings.push('caption.txt が無いのでキャプションは納品していません');
  // サムネイルは本番レンダーのたびに作られる。無い（古い案件・生成に失敗した）ときは知らせるだけ
  if (fs.existsSync(path.join(projectDir, deliverSource('thumbnail')))) kinds.push('thumbnail');
  else warnings.push('out/thumbnail.jpg が無いのでサムネイルは納品していません（Timeline の「サムネイル」で作れます）');

  const items: DeliverItem[] = [];
  for (const kind of kinds) {
    const from = path.join(projectDir, deliverSource(kind));
    if (!fs.existsSync(from)) {
      warnings.push(`${DELIVER_LABEL[kind]}: ${deliverSource(kind)} が無い`);
      continue;
    }
    let to = path.join(outputsDir, deliverFileName({shop: brief.shop.name, persona: persona.id, kind, label: opt.label}));
    let skipped: DeliverItem['skipped'];
    if (fs.existsSync(to) && !opt.overwrite) {
      if (sameFile(from, to)) skipped = 'same';
      else {
        // 過去の納品物は消さない。v2, v3… を探す
        let v = 2;
        while (fs.existsSync(path.join(outputsDir, deliverFileName({shop: brief.shop.name, persona: persona.id, kind, label: opt.label, version: v})))) v++;
        to = path.join(outputsDir, deliverFileName({shop: brief.shop.name, persona: persona.id, kind, label: opt.label, version: v}));
      }
    }
    if (!skipped) fs.copyFileSync(from, to);
    const bytes = fs.statSync(to).size;
    items.push({kind, from, to, bytes, skipped});
    log(skipped ? `  = ${path.basename(to)}（同じものが既にあるので何もしていません）` : `  → ${path.basename(to)}（${(bytes / 1024 / 1024).toFixed(1)} MB）`);
  }

  log(`納品: ${outputsDir}`);
  for (const w of warnings) log(`  ! ${w}`);
  return {items, outputsDir, warnings};
};
