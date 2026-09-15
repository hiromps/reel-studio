#!/usr/bin/env node
/**
 * Remotion 出力動画に AI ナレーションを合成する。
 *
 *   node mix-narration.cjs <narration.json> <ナレーションwavのディレクトリ> <入力mp4> <出力mp4>
 *
 * 例:
 *   node scripts/mix-narration.cjs \
 *     work/sample-reel/narration.json \
 *     work/sample-reel/narration \
 *     work/sample-reel/out/final.mp4 \
 *     work/sample-reel/out/final_narration.mp4
 *
 * 仕様（references/narration-tts.md §4 と対応。2026-08-27・2026-09-03に既知の罠を修正）:
 *   - 映像は -c:v copy（無劣化）。音声のみ差し替える
 *   - 元素材の環境音は volume=0.22（約-13dB）に絞って質感として残す
 *   - 全ブロックを narration.json の at 秒に adelay で先に配置し、1本のナレーション帯域に
 *     まとめてから `speechnorm`（ffmpegの音声正規化フィルタ。話者ごとの声量差を均す用途で
 *     設計されている）を1回だけ通し、ブロック間の音量ムラを均一化する。
 *     ⚠ 過去2回の罠（経緯）：
 *     ①2026-08-27：個別ブロックを loudnorm(I=-14:TP=-6.0:linear=true) の二重ターゲットで
 *     正規化すると、多くのブロックで両ターゲットが両立せず動的圧縮モードに落ちて
 *     波形が歪んだ（muse梅田さゆり版で発生）。→ 個別ブロックのloudnorm二重ターゲットをやめた。
 *     ②2026-09-03：①の対策として「各ブロックをTP-6.0に個別整列→Step3-4で中間ミックス全体に
 *     一律 (-14 - measured_I)dB のゲイン」という方式に変えたが、この追加ゲインが+6dBを
 *     超えるケースでは全ブロックのピークが 0dBFS を超えて**一律にクリップ**した
 *     （TAJIMA COFFEE hiro版で実測：追加ゲイン+7.57dB→全ブロックのピークが
 *     -6.0dB→+1.57dBTPに達して音割れ。さらにTP基準の個別整列は「ピークだけ揃えて
 *     ラウドネス(体感音量)は揃わない」ため、ブロックごとの体感音量の差＝「音量の波」も
 *     残っていた）。
 *     → 現在の方式：ブロック単位のゲイン計算をやめ、時系列に配置した帯域全体に対して
 *     `speechnorm`（expansion/compressionで体感音量を連続的に均しつつpeak上限を守る）を
 *     1回通すことで、ブロックごとの声量差を均一化する。さらにStep 3-4適用後に
 *     `alimiter`（閾値を超えた瞬間だけ短時間で抑えるピークリミッター。loudnormの
 *     継続的な動的圧縮と違い環境音の谷を持ち上げる副作用が出ない）を必ず通し、
 *     計算上の見落としがあっても物理的にクリップさせない最終防御にする。
 *   - 完成後にフレーム数・ラウドネス・区間音量・各セグメントの最大音量（クリップの有無）を
 *     自動検証する
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const [specPath, narrDir, srcVideo, dstVideo] = process.argv.slice(2);
if (!specPath || !narrDir || !srcVideo || !dstVideo) {
  console.error('使い方: node mix-narration.cjs <narration.json> <wavディレクトリ> <入力mp4> <出力mp4>');
  process.exit(1);
}

const TARGET_LUFS = -14;   // SNS標準
const FINAL_LIMITER_DB = -1.0; // Step4適用後の最終ピーク上限（alimiterで物理的に保護）

// speechnorm: ナレーション帯域全体の音量ムラを均す（ブロックごとの声量差を吸収する）
const SN_PEAK = 0.75;        // 帯域内のピーク上限（0-1。0.75≒-2.5dB。後段のゲイン分の余白を残す）
const SN_EXPANSION = 4;      // 静かなブロックを持ち上げる最大倍率
const SN_COMPRESSION = 2;    // 一部が飛び抜けて大きいブロックを抑える最大倍率
const SN_RMS = 0.15;         // 体感音量の目安（RMSターゲット。ピークだけでなく音量そのものを揃える）

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
// narration.json で上書きできる（GUI の Render 画面のスライダー）。指定が無ければ従来値
const AMBIENT_GAIN = typeof spec.ambientGain === 'number' ? spec.ambientGain : 0.22; // 元音声のダッキング量
const NARR_GAIN_DB = typeof spec.narrationGainDb === 'number' ? spec.narrationGainDb : 0; // ナレーション帯域に足すゲイン
const segs = spec.segments;
// 効果音（narration.json の sfx）。環境音のダッキングとは無関係の別レイヤーとして足す。
// 音源は公開リポジトリに入れられない（効果音ラボは素材の再配布が禁止）ので、
// 置き場は narration.json の sfxDir か環境変数 REEL_SFX_DIR で受け取る（Reel Studio が渡す）。
const SFX_GAIN_DB = typeof spec.sfxGainDb === 'number' ? spec.sfxGainDb : 0; // 効果音全体の増減
const SFX_DUCK = spec.sfxDuck !== false;            // 声に被った効果音を自動で沈ませる
const SFX_DUCK_THRESHOLD = typeof spec.sfxDuckThreshold === 'number' ? spec.sfxDuckThreshold : 0.03; // 声を検出する閾値（0-1）
const SFX_DUCK_RATIO = typeof spec.sfxDuckRatio === 'number' ? spec.sfxDuckRatio : 6;                // 沈ませる強さ
const SFX_ROOT = spec.sfxDir || process.env.REEL_SFX_DIR || '';
const sfxList = (Array.isArray(spec.sfx) ? spec.sfx : []).slice().sort((a, b) => a.at - b.at);
if (sfxList.length && !SFX_ROOT) {
  console.error('効果音の置き場が指定されていません（narration.json の sfxDir か環境変数 REEL_SFX_DIR）');
  process.exit(1);
}
for (const s of sfxList) {
  const abs = path.resolve(SFX_ROOT, s.file);
  if (!fs.existsSync(abs)) {
    console.error(`効果音が見つかりません: ${s.file}
  探した場所: ${abs}
  sfx/ に置くか narration.json の sfxDir で場所を指定してください`);
    process.exit(1);
  }
  s._abs = abs;
}
if (sfxList.length) console.log(`■ 効果音 ${sfxList.length} 個（全体 ${SFX_GAIN_DB >= 0 ? '+' : ''}${SFX_GAIN_DB}dB）`);

if (!segs || !segs.length) { console.error('segments が空です'); process.exit(1); }

const q = (p) => `"${path.resolve(p).replace(/\\/g, '/')}"`;
// 実行シェルはOSに合わせる（Windows=cmd.exe / mac・Linux=sh）
const run = (cmd) => execSync(cmd, { shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', maxBuffer: 1 << 26 }).toString();
const capture = (cmd) => {
  try { return run(cmd + ' 2>&1'); } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};

// ---- 入力の事前確認（ffmpeg の生エラーを見せないため、ここで日本語で止める） ----
const missing = [];
if (!fs.existsSync(srcVideo)) missing.push(`入力動画が無い: ${srcVideo}
    → 先に「本番レンダー」を実行してください（out/final.mp4 が要ります）`);
for (const s of segs) {
  const w = path.join(narrDir, s.id + '.wav');
  if (!fs.existsSync(w)) missing.push(`ナレーション音声が無い: ${path.relative(process.cwd(), w)}
    → 「音声を生成」を実行してください`);
}
if (missing.length) {
  console.error('■ 合成できません:');
  for (const m of missing) console.error('  - ' + m);
  process.exit(1);
}

// ---- Step 1: 全ブロックを at 秒に配置して1本のナレーション帯域にまとめる ----
console.log('■ Step 1: ナレーション帯域を作成（全ブロックをatの位置に配置）');
const rawInputs = segs.map((s) => `-i ${q(path.join(narrDir, s.id + '.wav'))}`).join(' ');
const delayChains = segs.map((s, i) => {
  const ms = Math.round(s.at * 1000);
  return `[${i}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms}[d${i}]`;
});
const mixChain = `${segs.map((_, i) => `[d${i}]`).join('')}amix=inputs=${segs.length}:duration=longest:normalize=0[narrRaw]`;
const rawTimeline = path.join(narrDir, '_narration_raw.wav');
run(`ffmpeg -hide_banner -loglevel error -y ${rawInputs} -filter_complex "${[...delayChains, mixChain].join(';')}" -map "[narrRaw]" ${q(rawTimeline)}`);

// ---- Step 2: speechnormでナレーション帯域全体の音量ムラを均一化 ----
console.log('■ Step 2: speechnormでブロック間の音量ムラを平準化');
const leveledTimeline = path.join(narrDir, '_narration_leveled.wav');
const snFilter = `speechnorm=peak=${SN_PEAK}:expansion=${SN_EXPANSION}:compression=${SN_COMPRESSION}:rms=${SN_RMS}:link=1`;
run(`ffmpeg -hide_banner -loglevel error -y -i ${q(rawTimeline)} -af ${snFilter},aresample=48000:resampler=soxr -ar 48000 ${q(leveledTimeline)}`);

// ---- Step 3: 環境音 + 均一化済みナレーション + 効果音を中間ミックスへ（loudnormなし） ----
console.log('■ Step 3: 中間ミックス作成（loudnormなし）');
const intermediateWav = path.join(narrDir, '_intermediate_mix.wav');
// 効果音は 1 個 1 入力。頭から trimSec だけ使い、切り口が目立たないよう末尾をフェードして at 秒へ置く
const sfxInputs = sfxList.map((s) => `-i ${q(s._abs)}`).join(' ');
const sfxChains = sfxList.map((s, i) => {
  const idx = 2 + i; // 0=元動画 / 1=ナレーション帯域
  const ms = Math.round(s.at * 1000);
  const parts = ['aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000'];
  if (typeof s.trimSec === 'number' && s.trimSec > 0) parts.push(`atrim=0:${s.trimSec}`, 'asetpts=N/SR/TB');
  const fade = typeof s.fadeOutSec === 'number' ? s.fadeOutSec : 0;
  if (fade > 0 && typeof s.trimSec === 'number' && s.trimSec > fade) parts.push(`afade=t=out:st=${(s.trimSec - fade).toFixed(3)}:d=${fade}`);
  parts.push(`volume=${((s.gainDb ?? 0) + SFX_GAIN_DB).toFixed(2)}dB`);
  if (ms > 0) parts.push(`adelay=${ms}|${ms}`);
  return `[${idx}:a]${parts.join(',')}[sfx${i}]`;
});

const chains = [
  `[0:a]volume=${AMBIENT_GAIN},aresample=48000:resampler=soxr[amb]`,
  `[1:a]volume=${NARR_GAIN_DB}dB,aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000[narrRawLvl]`,
  ...sfxChains,
];
let narrLabel = '[narrRawLvl]';
let sfxLabel = null;

if (sfxList.length === 1) sfxLabel = '[sfx0]';
else if (sfxList.length > 1) {
  chains.push(`${sfxList.map((_, i) => `[sfx${i}]`).join('')}amix=inputs=${sfxList.length}:duration=longest:normalize=0[sfxAll]`);
  sfxLabel = '[sfxAll]';
}

// 効果音がナレーションに被ったときは**効果音側を自動で沈ませる**（声を下げない）。
// sidechaincompress は「サイドチェイン入力が鳴っている間だけ本線を圧縮する」フィルタで、
// 放送でいうダッキングそのもの。これがあると、置く位置を声に気を使わず決められる。
if (sfxLabel && SFX_DUCK) {
  chains.push(`${narrLabel}asplit=2[narrMix][narrSc]`);
  chains.push(`${sfxLabel}[narrSc]sidechaincompress=threshold=${SFX_DUCK_THRESHOLD}:ratio=${SFX_DUCK_RATIO}:attack=20:release=250:level_sc=1[sfxDucked]`);
  narrLabel = '[narrMix]';
  sfxLabel = '[sfxDucked]';
}

const mixLabels = ['[amb]', narrLabel, ...(sfxLabel ? [sfxLabel] : [])].join('');
const mixInputs = 2 + (sfxLabel ? 1 : 0);
chains.push(`${mixLabels}amix=inputs=${mixInputs}:duration=first:normalize=0[mix]`);
run(`ffmpeg -hide_banner -loglevel error -y -i ${q(srcVideo)} -i ${q(leveledTimeline)} ${sfxInputs} ` +
  `-filter_complex "${chains.join(';')}" -map "[mix]" ${q(intermediateWav)}`);

// ---- Step 4: 中間ミックスの統合ラウドネスを計測 ----
const measureLog = capture(`ffmpeg -hide_banner -nostats -i ${q(intermediateWav)} -af loudnorm=I=${TARGET_LUFS}:print_format=json -f null -`);
const jm2 = measureLog.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
if (!jm2) { console.error('中間ミックスの計測に失敗しました:\n' + measureLog.slice(-1000)); process.exit(1); }
const measured = JSON.parse(jm2[0]);
const gainDb = TARGET_LUFS - parseFloat(measured.input_i);
console.log(`■ Step 4: 中間ミックス測定 input_i=${measured.input_i} LUFS → 固定ゲイン ${gainDb.toFixed(2)}dB`);

// ---- Step 5: 固定線形ゲインを1回だけ適用し、alimiterで物理的なクリップを最終防御 ----
// alimiterはloudnormの動的圧縮と違い閾値を超えた瞬間だけ短時間で抑える方式なので、
// ⚠ level=0 必須（2026-09-04・やきとり亭加美店hiro版で発覚）：alimiterの level（自動レベル）は既定で有効で、
//   ピークが limit に届くまで信号全体を持ち上げるため、固定ゲインで-14に合わせた後に+1dB程度
//   上振れして-12.9 LUFS／ピーク0dBFSになった。level=0 で-13.9 LUFS／-1.0dBFSに収まる
// 通常レベルの区間（環境音の谷など）には影響しない
const limiterLinear = Math.pow(10, FINAL_LIMITER_DB / 20).toFixed(4); // -1.0dB → 0.8913
fs.mkdirSync(path.dirname(path.resolve(dstVideo)), { recursive: true });
run(`ffmpeg -hide_banner -loglevel error -y -i ${q(srcVideo)} -i ${q(intermediateWav)} ` +
  `-filter_complex "[1:a]volume=${gainDb.toFixed(2)}dB,alimiter=limit=${limiterLinear}:attack=5:release=50:level=0[aout]" ` +
  `-map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 256k -ar 48000 -movflags +faststart ${q(dstVideo)}`);
console.log('■ 出力:', dstVideo);

// ---- 検証 ----
const frames = (f) =>
  run(`ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames,duration -of csv=p=0 ${q(f)}`).trim();
const before = frames(srcVideo);
const after = frames(dstVideo);
console.log(`■ 映像 (duration,frames)  元: ${before}  出力: ${after}  → ${before === after ? '一致（無劣化）' : '⚠ 不一致'}`);

const wholeVol = capture(`ffmpeg -hide_banner -nostats -i ${q(dstVideo)} -af volumedetect -f null -`);
const wholeMax = (wholeVol.match(/max_volume: .*/) || ['?'])[0];
console.log(`■ 全体の最大音量: ${wholeMax}（0dBFS未満であること＝物理的なクリップなし）`);

const lufs = capture(`ffmpeg -hide_banner -nostats -i ${q(dstVideo)} -af ebur128=framelog=quiet -f null -`);
const im = lufs.match(/^\s+I:\s+(-?[\d.]+) LUFS/m);
console.log(`■ 統合ラウドネス: ${im ? im[1] : '?'} LUFS（目標 ${TARGET_LUFS}）`);

// ナレーション区間と、その間の谷で音量差が出ることを確認する
console.log('■ 区間音量（ナレーション区間は谷より明確に大きいこと。区間同士の差が小さいほど「音量ムラ」が少ない）:');
let prevEnd = 0;
const segMeans = [];
for (const s of segs) {
  const gap = s.at - prevEnd;
  if (gap > 0.05) {
    const g = capture(`ffmpeg -hide_banner -nostats -ss ${prevEnd.toFixed(2)} -t ${Math.min(gap, 0.5).toFixed(2)} -i ${q(dstVideo)} -af volumedetect -f null -`);
    console.log(`   谷 ${prevEnd.toFixed(2)}-${s.at.toFixed(2)}s: ${(g.match(/mean_volume: .*/) || ['?'])[0]}`);
  }
  const v = capture(`ffmpeg -hide_banner -nostats -ss ${s.at.toFixed(2)} -t ${(s.durSec || 1).toFixed(2)} -i ${q(dstVideo)} -af volumedetect -f null -`);
  const mean = (v.match(/mean_volume: .*/) || ['?'])[0];
  const max = (v.match(/max_volume: .*/) || ['?'])[0];
  const meanDb = parseFloat((mean.match(/-?[\d.]+/) || [NaN])[0]);
  const maxDb = parseFloat((max.match(/-?[\d.]+/) || [NaN])[0]);
  if (Number.isFinite(meanDb)) segMeans.push(meanDb);
  // 実際に0dBFSを超えている（＝真のクリップ）場合のみ警告する。alimiterで抑えた
  // -0.1〜-0.9dB程度は正常（安全に保護されている状態）なので警告しない
  const clipFlag = Number.isFinite(maxDb) && maxDb >= -0.05 ? '  ⚠ クリップ疑い（0dBFS到達）' : '';
  console.log(`   ${s.id} ${s.at.toFixed(2)}s: ${mean} / ${max}${clipFlag}`);
  prevEnd = s.at + (s.durSec || 0);
}
if (segMeans.length > 1) {
  const spread = Math.max(...segMeans) - Math.min(...segMeans);
  console.log(`■ ブロック間の音量差（最大-最小）: ${spread.toFixed(1)}dB（目安: 4dB以下なら聞き取りやすい）`);
}

console.log('\n■ Claude は音を聴けない。聞き取りやすさとノイズはユーザーに確認を依頼すること。');
