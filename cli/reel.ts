#!/usr/bin/env node
// Reel Studio CLI。Claude（スキル）と人が同じ関数を叩く入口。
//   reel settings show [--json] | path | import-legacy [--from <dir>]   （設定の確認・旧来の置き場から Fish Audio の鍵を取り込む）
//   reel personas list [--json]                                          （人格の一覧。編集は GUI の Settings）
//   reel projects
//   reel new <slug> --persona <人格id> [--shop 店名]
//   reel new <slug> --from <既存slug> [--shop 別ブランド名] [--persona p] [--no-facts]   （同じ素材で別バージョン。素材はリンク共有）
//   reel catalog <materialsDir> --project <slug|dir> [--no-proxy] [--no-thumbs] [--scenes] [--speech] [--force]
//   reel tag --project P --export [out.json] | --import <file>
//   reel order --project P [--check] | --export [out.json] | --import <file> [--write] [--no-copy] [--force]
//   reel ai tag --project P [--force] [--batch n] [--concurrency n] [--model opus|sonnet|haiku]   （裏で claude を走らせてタグ付け）
//   reel ai order --project P [--write] [--no-copy] [--force] [--model m]        （同じく並べ替え）
//   reel ai telop --project P [--force] [--model m]                              （同じく {{gNN:intent}} を埋める）
//   reel ai narration --project P [--model m]                                    （テロップを見てナレーション原稿を書く）
//   reel ai edit --project P "<直したいこと>" [--model m]                         （自由指示で cuts/narration を修正）
//   reel ai script --project P [--model m] [--force] [--dry]                     （script.md の台本から cuts+narration を組み立て）
//   reel ai facts --project P [--force] [--model m]                              （店舗情報をWebで裏取り→brief.facts。Instagram優先）
//   reel ai caption --project P [--model m] [--no-research] ["<追加の指示>"]      （裏取り→caption.txt）
//   reel ai hooks --project P [--count 3] [--cut-count 3] [--fresh] [--force] [--model m] ["<追加の指示>"]  （トライアル用のフック案＋パターン別キャプション→hooks.json）
//   reel sfx scan | list                                                        （効果音ライブラリの棚卸し）
//   reel sfx role <file> <hook,telop,transition,reveal,eat,outro|-> [--trim s] [--fade s] [--gain dB] [--label 名]
//   reel sfx auto --project P [--max n] [--gap s] [--exclude role,role] [--dry]   （cuts.json から自動配置）
//   reel tts --project P [--force] [--id 01_a,02_b]                            （narration.json → narration/*.wav）
//   reel plan --project P [--write] [--no-reuse] [--no-copy] [--json]
//   reel validate --project P [--json] [--strict-proxy]
//   reel table --project P
//   reel aliases --project P
//   reel sync --project P [--check]
//   reel draft|render --project P [--out f] [--gl x] [--concurrency n] [--crf n] [--cache-size 256mb] [--retries n] [--force] [--force-errors] [--no-sync] [--strict-proxy] [--props f]
//   reel still --project P (--cut N | --frame F) [--out f]
//   reel trial --project P [--ids A,B] [--draft] [--no-deliver] [--gl x] [--force] [--force-errors]     （フックだけ差し替えた複数版。キャプションもパターンごとに納品）
//   reel winner --project P [--id A] [--tail "締めテロップ"] [--tail-narration "締めナレ"] [--caption-file f] [--speed 1.1] [--draft] [--no-deliver] [--force] [--force-errors] [--model m]  （勝ちパターンの二次活用：締めだけ変えて倍速で出し直す）
//   reel build --project P [--plan] [--steps caption,narration,tts,render,mix,deliver] [--model m] [--force-errors] [--label 修正版]  （仕上げ：残っている工程を順に走らせる）
//   reel deliver --project P [--label 修正版] [--allow-silent] [--overwrite]      （完成品だけ outputs/ へ）
//   reel install --project P
import fs from 'node:fs';
import path from 'node:path';
import {studioConfig} from '../studio.config';
import {loadSettings, maskSecret, mergeSettings, personasFile, saveSettings, settingsFile, settingsView} from '../core/settings';
import {readLegacyFishEnv} from '../core/legacy-env';
import {claudeBinInfo} from '../core/agent';
import {loadPersonasFromDisk} from '../core/personas-store';
import {PATH_KEYS, type SettingsPatch} from '../shared/schema/settings';
import {listPersonas} from '../shared/personas';
import {planCuts, PlanError} from '../shared/plan';
import {formatValidation} from '../shared/validate';
import {defaultPersonaId, getPersona} from '../shared/personas';
import {FORMAT_SPECS} from '../shared/format-specs';
import {PersonaIdSchema} from '../shared/schema/brief';
import {telopGroupsOf, cutDurationSec, totalSec} from '../shared/timeline';
import {buildCatalog, catalogToMarkdown, exportForTagging, importTags, loadCatalog} from '../core/catalog';
import {currentOrder, exportOrder, formatOrderCheck, importOrder, loadOrderEnv} from '../core/order';
import {aiCaption, aiEdit, aiFacts, aiNarration, aiOrder, aiTag, aiTelop} from '../core/ai';
import {aiScript} from '../core/script';
import {claudeAvailable, claudeBin} from '../core/agent';
import {generateTts} from '../core/tts';
import {autoPlaceSfx, readLibrary, scanLibrary, writeLibrary} from '../core/sfx';
import {deliver, narrationReady} from '../core/deliver';
import {buildPlan, runBuild} from '../core/build';
import {buildSelectionIssues, defaultBuildSelection, orderBuildSteps, type BuildStepId} from '../shared/build';
import {runTrial, readHooks} from '../core/trial';
import {aiHooks} from '../core/ai-trial';
import {runWinner} from '../core/winner';
import {TRIAL_POSTING_RULES} from '../shared/hooks';
import {SFX_ROLES, SFX_ROLE_LABEL, type SfxRole} from '../shared/sfx';
import {cloneProject, createProject, engineDiff, listProjects, npmInstall, readBrief, readCuts, resolveProjectDir, syncEngine, writeCuts} from '../core/project';
import {applyAliases, pendingAliases} from '../core/alias';
import {renderProject, renderStill, validateProject, PreflightError} from '../core/render';
import {readJsonLoose} from '../core/json-io';

type Flags = Record<string, string | boolean>;
const parseArgs = (argv: string[]): {cmd: string; pos: string[]; flags: Flags} => {
  const [cmd = 'help', ...rest] = argv;
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (a.startsWith('--no-')) flags[a.slice(5)] = false;
      else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) flags[a.slice(2)] = rest[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return {cmd, pos, flags};
};

const str = (f: Flags, k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
const num = (f: Flags, k: string): number | undefined => (str(f, k) !== undefined ? Number(str(f, k)) : undefined);
const bool = (f: Flags, k: string, d = false): boolean => (f[k] === undefined ? d : f[k] !== false && f[k] !== 'false');

const parseBytes = (s: string | undefined): number | undefined => {
  if (!s) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(gb|mb|kb|b)?$/i.exec(s);
  if (!m) return Number(s) || undefined;
  const n = parseFloat(m[1]);
  const u = (m[2] ?? 'b').toLowerCase();
  return Math.round(n * ({gb: 1024 ** 3, mb: 1024 ** 2, kb: 1024, b: 1} as Record<string, number>)[u]);
};

const projectFromFlags = (flags: Flags): string => {
  const p = str(flags, 'project');
  if (p) return resolveProjectDir(p);
  if (fs.existsSync(path.join(process.cwd(), 'cuts.json'))) return process.cwd();
  throw new Error('--project <slug|dir> を指定してください（cuts.json のある案件フォルダ）');
};

const out = (s: string) => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');
const filledLabel = (n: number) => (n ? `${n} グループ` : '書くものなし');

const help = () => {
  out(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//   reel')).map((l) => l.slice(3)).join('\n'));
};

async function main() {
  const {cmd, pos, flags} = parseArgs(process.argv.slice(2));
  // 人格は ~/.reel-studio/personas.json が正（無ければ同梱のサンプルで seed）
  loadPersonasFromDisk();
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      help();
      return;

    case 'settings': {
      const sub = pos[0] ?? 'show';
      if (sub === 'path') return out(settingsFile());
      if (sub === 'import-legacy') {
        // 旧来の置き場（Claude Code の settings.local.json / .mcp.json）から鍵を移す。値は表示しない
        const from = str(flags, 'from');
        const legacy = readLegacyFishEnv(from);
        if (!legacy.apiKey && !legacy.modelId)
          throw new Error(`旧来の置き場に FISH_API_KEY が見つかりません（探した: ${from ? `${from}/.claude/settings.local.json, ${from}/.mcp.json, ` : ''}~/.claude/settings.json）`);
        const patch: SettingsPatch = {tts: {...(legacy.apiKey ? {apiKey: legacy.apiKey} : {}), ...(legacy.modelId ? {modelId: legacy.modelId} : {})}};
        saveSettings(mergeSettings(loadSettings(), patch));
        if (legacy.apiKey) out(`FISH_API_KEY: 取り込みました（${maskSecret(legacy.apiKey)}）← ${legacy.sources.apiKey}`);
        if (legacy.modelId) out(`FISH_MODEL_ID: ${legacy.modelId} ← ${legacy.sources.modelId}`);
        out(`→ ${settingsFile()}`);
        return;
      }
      if (sub !== 'show') throw new Error('reel settings show [--json] | path | import-legacy [--from <dir>]');
      const info = claudeBinInfo();
      const v = settingsView({bin: info.bin, available: claudeAvailable(), source: info.source, version: null}, studioConfig.templateDir);
      if (bool(flags, 'json')) return out(JSON.stringify(v, null, 2));
      out(`設定ファイル: ${v.file}${v.exists ? '' : '（無い＝既定値で動作）'}`);
      if (v.problem) out(`! ${v.problem}`);
      for (const k of PATH_KEYS) out(`${k.padEnd(12)} ${v.paths[k].value}  (${v.paths[k].source}${v.paths[k].exists ? '' : '・まだ無い'})`);
      const key = v.settings.tts.apiKey;
      out(`Fish Audio   ${key.present ? `鍵あり ${key.masked}（${key.source === 'env' ? '環境変数' : '設定ファイル'}）` : '鍵なし'} / model ${v.settings.tts.modelId} / 追加ボイス ${v.settings.tts.voices.length} 件`);
      out(`claude       ${v.claude.bin}（${v.claude.source}${v.claude.available ? '' : '・見つからない'}）/ 既定モデル ${v.settings.agent.model}`);
      out(`人格         ${listPersonas().map((p) => p.id).join(', ')} ← ${personasFile()}`);
      return;
    }

    case 'personas': {
      const list = listPersonas();
      if (bool(flags, 'json')) return out(JSON.stringify(list, null, 2));
      out('| id | 表示名 | 型 | ボイス | speed | skillDir |');
      out('|---|---|---|---|---|---|');
      for (const p of list) out(`| ${p.id} | ${p.label} | ${p.defaultFormat} | ${p.narration.voiceId ? p.narration.voiceTitle || p.narration.voiceId : '（未設定）'} | ${p.narration.speed} | ${p.skillDir ?? ''} |`);
      out(`（${personasFile()}。編集は GUI の Settings「人格」）`);
      return;
    }

    case 'projects': {
      const list = listProjects();
      if (bool(flags, 'json')) return out(JSON.stringify(list, null, 2));
      out('| slug | persona | format | catalog | brief | cuts | narration | engine | node_modules | updated |');
      out('|---|---|---|---|---|---|---|---|---|---|');
      for (const p of list) out(`| ${p.slug} | ${p.persona ?? '-'} | ${p.format ?? '-'} | ${p.has.catalog ? '✓' : ''} | ${p.has.brief ? '✓' : ''} | ${p.has.cuts ? '✓' : ''} | ${p.has.narration ? '✓' : ''} | ${p.engine.stale ? 'STALE' : 'ok'} | ${p.nodeModules ? '✓' : '×'} | ${p.updatedAt.slice(0, 16)} |`);
      return;
    }

    case 'new': {
      const slug = pos[0];
      if (!slug) throw new Error('reel new <slug> --persona <人格id> | reel new <slug> --from <既存slug>');
      const from = str(flags, 'from');
      let dir: string;
      let created = true;
      if (from) {
        // 同じ素材で別バージョン（人格違い／同じ店の別ブランド）を作る。素材はハードリンクで共有する
        const r = cloneProject(from, slug, {
          persona: str(flags, 'persona') ? PersonaIdSchema.parse(str(flags, 'persona')) : undefined,
          shopName: str(flags, 'shop'),
          facts: bool(flags, 'facts', true),
          onLine: (l) => out(l),
        });
        dir = r.dir;
      } else {
        const persona = PersonaIdSchema.parse(str(flags, 'persona') ?? defaultPersonaId());
        const r = createProject(slug, {persona, shopName: str(flags, 'shop')});
        dir = r.dir;
        created = r.created;
      }
      if (!from) out(`${created ? '作成' : '既存に補完'}: ${dir}`);
      if (bool(flags, 'install', true) && !fs.existsSync(path.join(dir, 'node_modules', 'remotion'))) {
        out('npm install …');
        const ok = await npmInstall(dir, (l) => err(`  ${l}`));
        out(ok ? 'npm install 完了' : 'npm install に失敗（手動で実行してください）');
      }
      out(from ? `次: Brief でフックのクリップを選んで「プラン生成」（catalog は引き継いでいます）` : `次: reel catalog <素材フォルダ> --project ${slug}`);
      return;
    }

    case 'install': {
      const dir = projectFromFlags(flags);
      const ok = await npmInstall(dir, (l) => err(`  ${l}`));
      out(ok ? 'npm install 完了' : 'npm install に失敗');
      return;
    }

    case 'catalog': {
      const dir = projectFromFlags(flags);
      const materials = pos[0] ? path.resolve(pos[0]) : loadCatalog(dir)?.materialsDir;
      if (!materials) throw new Error('reel catalog <素材フォルダ> --project P');
      const {catalog, changed, warnings} = await buildCatalog({
        materialsDir: materials,
        projectDir: dir,
        slug: path.basename(dir),
        proxy: bool(flags, 'proxy', true),
        thumbs: bool(flags, 'thumbs', true),
        scenes: bool(flags, 'scenes'),
        speech: bool(flags, 'speech'),
        force: bool(flags, 'force'),
        onLine: (l) => err(l),
      });
      out(`catalog.json: ${catalog.clips.length} 本（主力 ${catalog.dominantFps}fps、更新 ${changed.length} ファイル）`);
      for (const w of warnings) out(`W ${w}`);
      out('');
      out(catalogToMarkdown(catalog));
      const untagged = catalog.clips.filter((c) => !c.tags).length;
      if (untagged) out(`\n未タグ ${untagged} 本 → reel tag --project ${path.basename(dir)} --export でサムネイルの場所を出し、tags を書いて --import`);
      return;
    }

    case 'tag': {
      const dir = projectFromFlags(flags);
      const catalog = loadCatalog(dir);
      if (!catalog) throw new Error('catalog.json が無い（先に reel catalog）');
      if (flags.import) {
        const file = str(flags, 'import');
        if (!file) throw new Error('--import <file>');
        const data = readJsonLoose(path.resolve(file)) as Parameters<typeof importTags>[2];
        const r = importTags(dir, catalog, data, (str(flags, 'source') as 'claude' | 'user') ?? 'claude');
        out(`updated ${r.updated.length}: ${r.updated.join(', ')}`);
        if (r.skipped.length) out(`skipped: ${r.skipped.join('; ')}`);
        out('');
        out(catalogToMarkdown(loadCatalog(dir)!));
        return;
      }
      const exp = exportForTagging(dir, catalog);
      const target = str(flags, 'export') ?? path.join(dir, studioConfig.studioDirName, 'tags-export.json');
      fs.writeFileSync(target, JSON.stringify(exp, null, 2));
      out(`書き出し: ${target}`);
      out(`サムネイル（1 枚ずつ view する。複数ファイルの合成は使わない）:`);
      for (const c of exp.clips) out(`  ${c.id} ${c.original} ${c.durationSec}s ${c.tags ? '' : '(未タグ)'} → ${c.sheet}`);
      return;
    }

    case 'ai': {
      const sub = pos[0];
      const dir = projectFromFlags(flags);
      if (!claudeAvailable()) err(`※ claude 実行ファイルが見つかりません（${claudeBin()}）。PATH に無い場合は Settings の「AI」か環境変数 REEL_STUDIO_CLAUDE_BIN で場所を指定してください`);
      const model = str(flags, 'model');

      if (sub === 'tag') {
        const r = await aiTag(dir, {force: bool(flags, 'force'), batchSize: num(flags, 'batch'), concurrency: num(flags, 'concurrency'), model, onLine: (l) => err(l)});
        out(`AI タグ付け: ${r.tagged.length} 本（${r.batches} 回 / $${r.costUsd.toFixed(3)}）${r.skipped.length ? ` / lock で除外 ${r.skipped.length} 本` : ''}`);
        if (r.facts.length) {
          out('読み取れた事実:');
          for (const f of r.facts) out(`  - ${f}`);
        }
        out('');
        out(catalogToMarkdown(loadCatalog(dir)!));
        return;
      }

      if (sub === 'order') {
        const r = await aiOrder(dir, {write: bool(flags, 'write'), copy: bool(flags, 'copy', true), force: bool(flags, 'force'), model, onLine: (l) => err(l)});
        out(formatOrderCheck(r.check));
        if (r.notes) out(`理由: ${r.notes}`);
        for (const x of r.reasons) out(`  ${x.clipId}: ${x.why}`);
        if (!r.applied) {
          err('E があるので何も書いていません（--force で無視できます）');
          process.exitCode = 1;
          return;
        }
        out(`brief.json を更新（order.mode=fixed / ${r.brief.order.fixed?.length ?? 0} カット）／ $${r.costUsd.toFixed(3)}`);
        out('');
        out(r.plan!.markdown);
        for (const w of r.plan!.warnings) out(`W ${w.code} ${w.message}`);
        if (r.written) {
          out(`cuts.json に書き込み（alias コピー ${r.aliasesApplied}）`);
          if (r.losesFinalTelops) err(`※ 記入済みだったテロップ ${r.losesFinalTelops} カット分は作り直しになりました`);
          if (r.validation) out(formatValidation(r.validation));
        } else err('（--write で cuts.json に書き込む）');
        return;
      }

      if (sub === 'telop') {
        const r = await aiTelop(dir, {force: bool(flags, 'force'), model, onLine: (l) => err(l)});
        out(`AI テロップ: ${filledLabel(r.filled.length)}（$${r.costUsd.toFixed(3)}）`);
        for (const f of r.filled) out(`  ${f.id}: ${f.text}`);
        if (r.skipped.length) out(`skipped: ${r.skipped.join('; ')}`);
        if (r.notes) out(`意図: ${r.notes}`);
        if (r.validation) {
          out('');
          out(formatValidation(r.validation));
        }
        return;
      }

      if (sub === 'narration') {
        const r = await aiNarration(dir, {model, onLine: (l) => err(l)});
        out(`AI ナレーション: ${r.blocks.length} ブロック / 動画 ${r.videoSec.toFixed(2)} 秒（$${r.costUsd.toFixed(3)}）`);
        for (const b of r.blocks) out(`  ${b.at.toFixed(2)}s  ${b.text}`);
        for (const f of r.findings) out(`  ! ${f}`);
        if (r.notes) out(`意図: ${r.notes}`);
        out('※ 音声はまだありません（全ブロック needsTts）。`reel tts --project P` か GUI の「音声を生成」で作ります');
        return;
      }

      if (sub === 'script') {
        const r = await aiScript(dir, {model, write: !bool(flags, 'dry'), force: bool(flags, 'force'), onLine: (l) => err(l)});
        out(`台本から ${r.plan.cuts.length} カット / ${r.totalSec.toFixed(2)} 秒 / ナレーション ${r.plan.narration.length} ブロック（$${r.costUsd.toFixed(3)}）`);
        for (const l of r.lines) out(l);
        for (const i of r.issues) out(`  ${i.severity} ${i.code} ${i.message}`);
        for (const u of r.plan.unmatched) out(`  ? 素材が無い: ${u}`);
        if (!r.written) out('（書いていません）');
        return;
      }

      if (sub === 'facts') {
        const r = await aiFacts(dir, {model, force: bool(flags, 'force'), onLine: (l) => err(l)});
        out(`裏取り: 追加 ${r.added.length} 件 / 既存を維持 ${r.kept.length} 件（$${r.costUsd.toFixed(3)}）`);
        for (const [k, v] of Object.entries(r.facts)) out(`  ${k}: ${v}`);
        for (const c of r.conflicts) out(`  ! 食い違い ${c.key}: ${c.detail} → ${c.chose}`);
        for (const u of r.unresolved) out(`  ? 確認できず: ${u}`);
        return;
      }

      if (sub === 'caption') {
        const r = await aiCaption(dir, {
          model,
          instruction: pos.slice(1).join(' ') || str(flags, 'prompt'),
          research: bool(flags, 'research', true),
          researchForce: bool(flags, 'research-force'),
          onLine: (l) => err(l),
        });
        out(r.caption);
        out('');
        out(`→ ${path.relative(process.cwd(), r.file)}（$${r.costUsd.toFixed(3)}）`);
        for (const i of r.issues) out(`  ${i.severity} ${i.code} ${i.message}`);
        for (const m of r.missing) out(`  ? 要確認: ${m}`);
        return;
      }

      if (sub === 'edit') {
        const instruction = pos.slice(1).join(' ') || str(flags, 'prompt') || '';
        if (!instruction.trim()) throw new Error('reel ai edit --project P "<直したいこと>"');
        const r = await aiEdit(dir, instruction, {model, onLine: (l) => err(l)});
        out(r.summary);
        for (const a of r.applied) out(`  ✓ ${a}`);
        for (const u of r.unapplied) out(`  ! ${u}`);
        if (r.needsTts.length) out(`※ ナレーション ${r.needsTts.join(', ')} は音声を作り直す必要があります（needsTts: true を付けました）`);
        out(`（$${r.costUsd.toFixed(3)}）`);
        if (r.validation) {
          out('');
          out(formatValidation(r.validation));
        }
        return;
      }

      if (sub === 'hooks') {
        const r = await aiHooks(dir, {
          count: num(flags, 'count'),
          cutCount: num(flags, 'cut-count'),
          fresh: bool(flags, 'fresh'),
          force: bool(flags, 'force'),
          model,
          instruction: pos.slice(1).join(' ') || str(flags, 'prompt'),
          onLine: (l) => err(l),
        });
        out(`hooks.json: ${r.hooks.variants.length} パターン／差し替え範囲 冒頭 ${r.cutCount} カット（${r.spanSec.toFixed(2)} 秒）／$${r.costUsd.toFixed(3)}`);
        for (const v of r.hooks.variants) {
          out(`\n## パターン ${v.id}${v.angle ? `［${v.angle}］` : ''}${v.label ? ` — ${v.label}` : ''}`);
          out(`テロップ: ${v.telops.map((t) => (t ? `「${t}」` : '（今のまま）')).join(' → ')}`);
          out(`ナレーション: ${v.narration ? `「${v.narration}」` : '（今のまま）'}`);
          if (r.why[v.id]) out(`狙い: ${r.why[v.id]}`);
          out(v.caption ? `キャプション:\n${v.caption}` : 'キャプション: 共通の caption.txt');
        }
        out('');
        for (const i of r.issues) out(`  ${i.severity} ${i.code} ${i.message}`);
        out(`次: reel trial --project ${path.basename(dir)}（レンダー→音声→mix→納品。キャプションもパターンごとに出ます）`);
        return;
      }

      err('reel ai tag | reel ai order | reel ai telop | reel ai script | reel ai narration | reel ai facts | reel ai caption | reel ai hooks | reel ai edit "<直したいこと>"');
      process.exitCode = 1;
      return;
    }

    case 'order': {
      const env = loadOrderEnv(projectFromFlags(flags));
      const spec = env.spec;

      if (flags.import) {
        const file = str(flags, 'import');
        if (typeof file !== 'string') throw new Error('--import <file>');
        const r = importOrder(env, readJsonLoose(path.resolve(file)), {
          write: bool(flags, 'write'),
          copy: bool(flags, 'copy', true),
          force: bool(flags, 'force'),
          allowReuse: bool(flags, 'reuse', true),
        });
        out(formatOrderCheck(r.check));
        if (!r.applied) {
          err('E があるので何も書いていません。order を直して再実行してください（承知のうえで進めるなら --force）');
          process.exitCode = 1;
          return;
        }
        for (const x of r.reasons) out(`  ${x.clipId}: ${x.why}`);
        out(`brief.json を更新（order.mode=fixed / ${r.brief.order.fixed?.length ?? 0} カット）`);
        out('');
        out(`# カット表（${spec.id} ${spec.name} / ${r.plan!.cuts.cuts.length} カット / ${totalSec(r.plan!.cuts).toFixed(1)} 秒）`);
        out(r.plan!.markdown);
        for (const w of r.plan!.warnings) out(`W ${w.code} ${w.message}`);
        if (r.written) {
          out(`cuts.json に書き込み（alias コピー ${r.aliasesApplied}）`);
          if (r.losesFinalTelops) err(`※ 記入済みだったテロップ ${r.losesFinalTelops} カット分は作り直しになりました（{{gNN:intent}} を埋め直す）`);
          if (r.validation) out(formatValidation(r.validation));
        } else {
          err('（--write で cuts.json に書き込む）');
          if (r.losesFinalTelops) err(`※ --write すると記入済みテロップ ${r.losesFinalTelops} カット分は作り直しになります`);
        }
        return;
      }

      if (flags.export) {
        const {file, payload} = exportOrder(env, str(flags, 'export'));
        out(`書き出し: ${file}`);
        out(`型: ${spec.id} ${spec.name} / ${payload.format.targetSec} 秒 / 推奨 ${payload.format.recommendedCuts[0]}〜${payload.format.recommendedCuts[1]} カット`);
        out('並べ方の指示:');
        for (const p of payload.principles) out(`  - ${p}`);
        out('サムネイル（1 枚ずつ view する。複数ファイルの合成は使わない）:');
        for (const c of payload.clips) out(`  ${c.id} ${c.description || c.slug} ${c.durationSec.toFixed(2)}s${c.signage ? ' [看板]' : ''}${c.ng ? ' [NG]' : ''} → ${c.sheet}`);
        out(`並べたら: reel order --project ${env.slug} --import <file> --write`);
        return;
      }

      const cur = currentOrder(env);
      if (!cur) {
        // ファイルはあるのに並びが取れない＝src が catalog と対応していない（テンプレートのままなど）
        err(
          fs.existsSync(path.join(env.dir, 'cuts.json'))
            ? 'cuts.json の src が catalog のクリップと対応しません（テンプレートのままかも）。まず reel plan --write で構成を作ってください'
            : 'cuts.json が無い（まず reel plan --write か reel order --export → --import）',
        );
        process.exitCode = 1;
        return;
      }
      if (bool(flags, 'json')) return out(JSON.stringify(cur, null, 2));
      out(`現在の並び: ${cur.order.join(' → ')}`);
      out(formatOrderCheck(cur.check));
      return;
    }

    case 'plan': {
      const dir = projectFromFlags(flags);
      const catalog = loadCatalog(dir);
      const brief = readBrief(dir);
      if (!catalog) throw new Error('catalog.json が無い（先に reel catalog）');
      if (!brief) throw new Error('brief.json が無い（reel new で雛形を作るか GUI の Brief で保存）');
      let existing;
      try {
        existing = readCuts(dir);
      } catch {
        existing = undefined;
      }
      const r = planCuts({catalog, brief, existing, options: {allowReuse: bool(flags, 'reuse', true)}});
      if (bool(flags, 'json')) {
        out(JSON.stringify({cuts: r.cuts, aliases: r.aliases, warnings: r.warnings, table: r.table}, null, 2));
      } else {
        const spec = FORMAT_SPECS[brief.format ?? getPersona(brief.persona).defaultFormat];
        out(`# カット表（${spec.id} ${spec.name} / ${brief.persona} / ${r.cuts.cuts.length} カット / ${totalSec(r.cuts).toFixed(1)} 秒 / テロップ ${telopGroupsOf(r.cuts).length} グループ）`);
        out(r.markdown);
        if (r.aliases.length) out(`\nalias: ${r.aliases.map((a) => `${a.from} → ${a.to}`).join(', ')}`);
        for (const w of r.warnings) out(`W ${w.code} ${w.message}`);
      }
      if (bool(flags, 'write')) {
        writeCuts(dir, r.cuts);
        const done = bool(flags, 'copy', true) ? applyAliases(dir, r.cuts) : [];
        if (done.length) writeCuts(dir, r.cuts);
        err(`cuts.json に書き込み（alias コピー ${done.length}）。次: {{…}} を埋めて reel validate`);
      } else err('（--write で cuts.json に書き込む）');
      return;
    }

    case 'validate': {
      const dir = projectFromFlags(flags);
      const r = validateProject(dir, {strictProxy: bool(flags, 'strict-proxy')});
      if (bool(flags, 'json')) out(JSON.stringify(r, null, 2));
      else out(formatValidation(r));
      process.exitCode = r.ok ? 0 : 1;
      return;
    }

    case 'table': {
      const dir = projectFromFlags(flags);
      const cuts = readCuts(dir);
      const slots = new Map((cuts.meta?.slots ?? []).map((s) => [s.cutId, s]));
      out('| No | 区間 | 役割 | src | IN | OUT | 尺 | rate | テロップ | 向き |');
      out('|---|---|---|---|---|---|---|---|---|---|');
      cuts.cuts.forEach((c, i) => {
        const s = c.id ? slots.get(c.id) : undefined;
        const telop = c.subs?.length ? c.subs.map((x) => x.text).join(' / ') : (c.main?.text ?? '');
        out(`| ${i + 1} | ${s?.segment ?? ''} | ${s?.role ?? ''} | ${c.src} | ${c.inSec} | ${c.outSec} | ${cutDurationSec(c).toFixed(2)} | ${c.playbackRate ?? ''} | ${c.badge ? `[${c.badge}] ` : ''}${telop} | ${c.main?.orientation ?? (c.subs?.length ? 'subs' : '')} |`);
      });
      out(`\n合計 ${totalSec(cuts).toFixed(2)} 秒 / ${cuts.cuts.length} カット / テロップ ${telopGroupsOf(cuts).length} グループ`);
      return;
    }

    case 'aliases': {
      const dir = projectFromFlags(flags);
      const cuts = readCuts(dir);
      const pend = pendingAliases(dir, cuts);
      const done = applyAliases(dir, cuts);
      if (done.length || pend.length) writeCuts(dir, cuts);
      out(`alias 適用 ${done.length} 件（未適用だった ${pend.length} 件）`);
      return;
    }

    case 'trial': {
      const dir = projectFromFlags(flags);
      if (!readHooks(dir)) throw new Error('hooks.json が無い（フック候補を書いてください。GUI の「トライアル（フック差し替え）」でも作れます）');
      const idsArg = str(flags, 'ids');
      try {
        const r = await runTrial(dir, {
          ids: idsArg ? idsArg.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
          deliver: bool(flags, 'deliver', true),
          draft: bool(flags, 'draft'),
          gl: str(flags, 'gl'),
          force: bool(flags, 'force'),
          allowErrors: bool(flags, 'force-errors'),
          onLine: (l) => err(l),
        });
        for (const it of r.items) out(`${it.id}	${it.durationSec.toFixed(2)}s	${it.deliveredAs ?? it.outRel}${it.captionAs ? `	${it.captionAs}` : ''}`);
        if (bool(flags, 'deliver', true) && !bool(flags, 'draft')) {
          out('\n投稿の運用ルール:');
          for (const rule of TRIAL_POSTING_RULES) out(`  ・${rule}`);
        }
      } catch (e) {
        if (e instanceof PreflightError) {
          err(e.message);
          err('（並びやテロップを自分で決めていて、検証の意見で止められたくない場合は --force-errors）');
          process.exitCode = 2;
          return;
        }
        throw e;
      }
      return;
    }

    // 勝ちパターンの二次活用：締めだけ変えて倍速で出し直し、新しいキャプションで納品
    case 'winner': {
      const dir = projectFromFlags(flags);
      const captionFile = str(flags, 'caption-file');
      try {
        const r = await runWinner(dir, {
          id: str(flags, 'id'),
          tailTelop: str(flags, 'tail'),
          tailNarration: str(flags, 'tail-narration'),
          caption: captionFile ? fs.readFileSync(path.resolve(captionFile), 'utf8') : undefined,
          speed: num(flags, 'speed'),
          draft: bool(flags, 'draft'),
          deliver: bool(flags, 'deliver', true),
          gl: str(flags, 'gl'),
          force: bool(flags, 'force'),
          allowErrors: bool(flags, 'force-errors'),
          model: str(flags, 'model'),
          instruction: pos.join(' ') || undefined,
          onLine: (l) => err(l),
        });
        out(`${r.key}	${r.speed}x	${r.durationSec.toFixed(2)}s	${r.deliveredAs ?? r.outRel}${r.captionAs ? `	${r.captionAs}` : ''}`);
        out(`締め: 「${r.tailTelop}」${r.tailNarration ? ` / ナレ「${r.tailNarration}」` : ''}`);
        if (r.caption) out(`\nキャプション:\n${r.caption}`);
      } catch (e) {
        if (e instanceof PreflightError) {
          err(e.message);
          err('（並びやテロップを自分で決めていて、検証の意見で止められたくない場合は --force-errors）');
          process.exitCode = 2;
          return;
        }
        throw e;
      }
      return;
    }

    // 仕上げ：案件の状態から残っている工程を決めて順に走らせる（GUI の Render「仕上げ」と同じ）
    case 'build': {
      const dir = projectFromFlags(flags);
      const {facts, steps} = buildPlan(dir);
      const stepsArg = str(flags, 'steps');
      const selected = stepsArg ? orderBuildSteps(stepsArg.split(',').map((x) => x.trim()).filter(Boolean) as BuildStepId[]) : defaultBuildSelection(steps);
      for (const st of steps) err(`  ${st.status === 'done' ? '済' : st.status === 'todo' ? (selected.includes(st.id) ? '▶' : '－') : '×'} ${st.label}  ${st.detail}`);
      if (facts.placeholders) err(`  ! テロップが ${facts.placeholders} 件未記入`);
      const issues = buildSelectionIssues(steps, selected);
      for (const i of issues) err(`  ! ${i}`);
      if (bool(flags, 'plan') || !selected.length) {
        if (!selected.length) err('走らせる工程はありません');
        return;
      }
      if (issues.length && !bool(flags, 'force')) throw new Error('選び方に問題があります（--force で無視できます）');
      err(`実行: ${selected.join(' → ')}`);
      const r = await runBuild(dir, {
        steps: selected,
        model: str(flags, 'model'),
        allowErrors: bool(flags, 'force-errors'),
        label: str(flags, 'label'),
        gl: str(flags, 'gl'),
        onLine: (l) => err(l),
      });
      out(`ran\t${r.ran.join(',')}`);
      for (const d of r.delivered ?? []) out(`delivered\t${d}`);
      return;
    }

    case 'deliver': {
      const dir = projectFromFlags(flags);
      const ready = narrationReady(dir);
      if (!ready.ok && !bool(flags, 'allow-silent')) err(`（ナレーション付きが出せません: ${ready.reason}）`);
      const r = await deliver(dir, {
        label: str(flags, 'label'),
        allowSilent: bool(flags, 'allow-silent'),
        overwrite: bool(flags, 'overwrite'),
        onLine: (l) => err(l),
      });
      for (const x of r.items) out(`${x.skipped ? '（同じ）' : ''}${x.to}`);
      return;
    }

    case 'sfx': {
      const sub = pos[0] ?? 'list';

      if (sub === 'scan') {
        await scanLibrary({onLine: (l) => out(l)});
        return;
      }

      if (sub === 'list') {
        const lib = readLibrary();
        if (!lib.sounds.length) return out('効果音がありません（sfx/ に音源を置いて reel sfx scan）');
        out('| ファイル | 表示名 | 尺 | 役割 | trim | fade | gain |');
        out('|---|---|---|---|---|---|---|');
        for (const x of lib.sounds)
          out(`| ${x.file} | ${x.label} | ${(x.durSec ?? 0).toFixed(2)}s | ${x.roles.length ? x.roles.join(',') : '（未設定）'} | ${x.defaultTrimSec ?? '-'} | ${x.defaultFadeOutSec ?? '-'} | ${x.defaultGainDb ?? '-'} |`);
        out('');
        out(`役割: ${SFX_ROLES.map((r) => `${r}=${SFX_ROLE_LABEL[r]}`).join(' / ')}`);
        return;
      }

      if (sub === 'role') {
        const file = pos[1];
        const rolesArg = pos[2];
        if (!file || rolesArg === undefined) throw new Error('reel sfx role <file> <役割をカンマ区切り。- で解除> [--trim s] [--fade s] [--gain dB] [--label 名]');
        const lib = readLibrary();
        const sound = lib.sounds.find((x) => x.file === file || x.label === file);
        if (!sound) throw new Error(`ライブラリにありません: ${file}（reel sfx list で確認）`);
        if (rolesArg !== '-') {
          const roles = rolesArg.split(',').map((r) => r.trim()).filter(Boolean);
          const bad = roles.filter((r) => !(SFX_ROLES as readonly string[]).includes(r));
          if (bad.length) throw new Error(`知らない役割: ${bad.join(', ')}（使えるのは ${SFX_ROLES.join(' / ')}）`);
          sound.roles = roles as SfxRole[];
        } else sound.roles = [];
        const trim = num(flags, 'trim');
        const fade = num(flags, 'fade');
        const gain = num(flags, 'gain');
        const label = str(flags, 'label');
        if (trim !== undefined) sound.defaultTrimSec = trim;
        if (fade !== undefined) sound.defaultFadeOutSec = fade;
        if (gain !== undefined) sound.defaultGainDb = gain;
        if (label) sound.label = label;
        if (str(flags, 'source')) sound.source = str(flags, 'source');
        writeLibrary(lib);
        out(`${sound.label}: 役割 ${sound.roles.length ? sound.roles.join(',') : '（なし）'} / 尺 ${(sound.durSec ?? 0).toFixed(2)}s → 頭 ${sound.defaultTrimSec ?? '全部'}s / fade ${sound.defaultFadeOutSec ?? 0}s / ${sound.defaultGainDb ?? 0}dB`);
        return;
      }

      if (sub === 'auto') {
        const dir = projectFromFlags(flags);
        const exclude = (str(flags, 'exclude') ?? '').split(',').map((x) => x.trim()).filter(Boolean) as SfxRole[];
        const r = await autoPlaceSfx(dir, {
          max: num(flags, 'max'),
          minGapSec: num(flags, 'gap'),
          exclude: exclude.length ? exclude : undefined,
          write: !bool(flags, 'dry'),
          onLine: (l) => out(l),
        });
        if (bool(flags, 'dry')) out('（--dry なので narration.json は書いていません）');
        return;
      }

      err('reel sfx scan | reel sfx list | reel sfx role <file> <役割> | reel sfx auto --project P');
      process.exitCode = 1;
      return;
    }

    case 'tts': {
      const dir = projectFromFlags(flags);
      const only = str(flags, 'id');
      const r = await generateTts(dir, {force: bool(flags, 'force'), ids: typeof only === 'string' ? only.split(',').map((x) => x.trim()).filter(Boolean) : undefined, onLine: (l) => err(l)});
      out(`音声生成 ${r.made.length} 本 / ${r.chars} 文字（model ${r.modelId}）`);
      for (const id of r.made) out(`  ${id}.wav`);
      return;
    }

    case 'sync': {
      const dir = projectFromFlags(flags);
      const diff = engineDiff(dir);
      if (bool(flags, 'check') || !diff.stale) {
        out(diff.stale ? `STALE: ${diff.files.filter((f) => f.status !== 'ok').map((f) => `${f.file}(${f.status})`).join(', ')}` : 'エンジンはマスターと一致');
        return;
      }
      const r = syncEngine(dir);
      out(`同期: ${r.synced.join(', ')}（旧版は .studio/backups/engine-*/）`);
      return;
    }

    case 'draft':
    case 'render': {
      const dir = projectFromFlags(flags);
      try {
        const r = await renderProject({
          projectDir: dir,
          draft: cmd === 'draft',
          out: str(flags, 'out'),
          gl: str(flags, 'gl'),
          concurrency: num(flags, 'concurrency'),
          crf: num(flags, 'crf'),
          cacheBytes: parseBytes(str(flags, 'cache-size')),
          retries: num(flags, 'retries'),
          force: bool(flags, 'force'),
          allowErrors: bool(flags, 'force-errors'),
          noSync: flags.sync === false,
          strictProxy: bool(flags, 'strict-proxy'),
          props: str(flags, 'props'),
          onLine: (l) => err(l),
        });
        out(`OK ${r.outPath} (${(r.sizeBytes / 1024 / 1024).toFixed(1)} MB, ${r.frames}f / 期待 ${r.expectedFrames}f, ${r.durationSec.toFixed(2)}s, ${r.attempts} 回目で成功)`);
        if (r.qcTile) out(`QC: ${r.qcTile}`);
        for (const w of r.warnings) out(`W ${w}`);
      } catch (e) {
        if (e instanceof PreflightError) {
          err(e.message);
          err('（並びやテロップを自分で決めていて、検証の意見で止められたくない場合は --force-errors）');
          process.exitCode = 2;
          return;
        }
        throw e;
      }
      return;
    }

    case 'still': {
      const dir = projectFromFlags(flags);
      const r = await renderStill(dir, {cut: num(flags, 'cut'), frame: num(flags, 'frame'), offsetSec: num(flags, 'offset'), out: str(flags, 'out'), gl: str(flags, 'gl'), onLine: (l) => err(l)});
      out(`OK ${r.out} (frame ${r.frame})`);
      return;
    }

    default:
      err(`不明なコマンド: ${cmd}`);
      help();
      process.exitCode = 1;
  }
}

main().catch((e) => {
  if (e instanceof PlanError) err(`PLAN ${e.code}: ${e.message}`);
  else err(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
