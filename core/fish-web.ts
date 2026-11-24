// Fish Audio の Web 画面（fish.audio の読み上げページ）を裏で操作して音声を作る。
//
// API（core/tts.ts の既定の経路）は従量課金、Web 画面は月額プランのクレジットを使う。
// Settings「音声生成」で経路を「Web 画面」にしたときだけ、core/tts.ts の synth がここを呼ぶ。
//
// - PC に入っている Chrome / Edge を playwright-core で起動する（ブラウザは同梱しない）
// - ログインは人がする。専用プロファイル（<設定の置き場>/fish-web-profile）にログイン状態が残る。
//   パスワードはここを通らない。ボット検知の回避もしない（止められたら窓を出す設定で人が通す）
// - 画面の部品は 2026-11-24 に確かめたもの。Fish Audio が画面を変えると動かなくなるので、
//   失敗したときは <設定の置き場>/fish-web-debug/ に画面の写しと通信の一覧を残す
// - Fish Audio の利用規約は自動化された手段でのアクセスを禁じている。使う人が承知のうえで切り替える
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {BrowserContext, Page, Response} from 'playwright-core';
import {execOk} from './exec';
import {loadSettings, settingsDir} from './settings';

const TTS_URL = 'https://fish.audio/ja/app/text-to-speech/';
const CHANNELS = ['chrome', 'msedge'] as const;
/** 1 本の生成を待つ上限 */
const GENERATE_TIMEOUT_MS = 180_000;
/** 使い終わってからブラウザを閉じるまで（続けて作るときに起動し直さない） */
const IDLE_CLOSE_MS = 90_000;

export const FISH_WEB_LOGIN_NEEDED = 'Fish Audio の Web 画面にログインしていません。Settings の「音声生成」で「Web 画面にログイン」を押してログインしてください';

export const fishWebProfileDir = (): string => path.join(settingsDir(), 'fish-web-profile');
const debugDir = (): string => path.join(settingsDir(), 'fish-web-debug');

/** Web 画面のモデル選択に出る名前（API の model id → 画面の表示名） */
const WEB_MODEL_LABEL: Record<string, RegExp> = {
  'drama-3': /Drama\s*3/i,
  's2.1-pro': /S2\.1\s*Pro/i,
  's2.1-pro-free': /S2\.1\s*Pro/i,
  's2-pro': /S2\s+Pro/i,
  s1: /\bS1\b/i,
};

export type FishWebRequest = {text: string; voiceId: string; speed: number; volume: number; modelId: string};

type Session = {ctx: BrowserContext; page: Page; headless: boolean; channel: string; voiceId: string | null};
let session: Session | null = null;
let loginCtx: BrowserContext | null = null;
let idleTimer: NodeJS.Timeout | null = null;
/** ブラウザは 1 つなので、生成も状態確認も 1 つずつ順に通す */
let chain: Promise<unknown> = Promise.resolve();
const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error('中断されました');
};

const launch = async (headless: boolean): Promise<{ctx: BrowserContext; channel: string}> => {
  const {chromium} = await import('playwright-core');
  fs.mkdirSync(fishWebProfileDir(), {recursive: true});
  let last = '';
  for (const channel of CHANNELS) {
    try {
      const ctx = await chromium.launchPersistentContext(fishWebProfileDir(), {channel, headless, viewport: {width: 1360, height: 900}, locale: 'ja-JP', acceptDownloads: true});
      return {ctx, channel};
    } catch (e) {
      last = (e as Error).message.split('\n')[0];
    }
  }
  throw new Error(`Chrome か Edge を起動できませんでした（${last}）。どちらかをインストールするか、開いたままの「Web 画面にログイン」の窓を閉じてください`);
};

const closeSession = async () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const s = session;
  session = null;
  await s?.ctx.close().catch(() => {});
};

const closeLogin = async () => {
  const c = loginCtx;
  loginCtx = null;
  await c?.close().catch(() => {});
};

/** プロセス終了時や設定を変えたときに呼ぶ */
export const closeFishWeb = async (): Promise<void> => {
  await closeLogin();
  await closeSession();
};

const acquire = async (): Promise<Session> => {
  const headless = loadSettings().tts.webHeadless;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  // ログイン用の窓が同じプロファイルを掴んでいると起動できない。閉じればログイン状態は残る
  await closeLogin();
  if (session && (session.headless !== headless || session.page.isClosed())) await closeSession();
  if (!session) {
    const {ctx, channel} = await launch(headless);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    session = {ctx, page, headless, channel, voiceId: null};
    ctx.on('close', () => {
      if (session?.ctx === ctx) session = null;
    });
  }
  return session;
};

const release = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void closeSession(), IDLE_CLOSE_MS);
  idleTimer.unref();
};

// ───────────────────────── 画面の読み取り ─────────────────────────

const generateButton = (page: Page) => page.locator('[data-testid="tts-generate"]');
const editor = (page: Page) => page.locator('[role="textbox"].ProseMirror').first();
const modelSelector = (page: Page) => page.locator('[data-testid="tts-model-selector"]');

/** ログイン画面（Google などで続行）が出ているか */
const authDialogOpen = (page: Page): Promise<boolean> =>
  page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.querySelector('button[aria-label*="Google"]') !== null));

/** 右上に「ログイン」ボタンがある＝未ログイン */
const loggedOut = async (page: Page): Promise<boolean> =>
  (await authDialogOpen(page)) || page.evaluate(() => [...document.querySelectorAll('button, a')].some((b) => /^(ログイン|Log ?in|Sign ?in)$/i.test((b.textContent ?? '').trim())));

/** お知らせのポップアップを閉じる（設定パネルも dialog なので、タブを持つものは触らない） */
const dismissPromos = async (page: Page) => {
  for (let i = 0; i < 4; i++) {
    const closed = await page.evaluate(() => {
      for (const d of document.querySelectorAll('[role="dialog"]')) {
        if (d.querySelector('[role="tablist"]') || d.querySelector('button[aria-label*="Google"]')) continue;
        const btn = [...d.querySelectorAll('button')].find((b) => /^(close|閉じる)$/i.test(((b.textContent ?? '').trim() || b.getAttribute('aria-label')) ?? ''));
        if (btn) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (!closed) return;
    await page.waitForTimeout(400);
  }
};

const openPage = async (s: Session, voiceId: string | null) => {
  const {page} = s;
  const url = voiceId ? `${TTS_URL}?modelId=${encodeURIComponent(voiceId)}` : TTS_URL;
  if (s.voiceId !== voiceId || !page.url().startsWith(TTS_URL)) {
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60_000});
    s.voiceId = voiceId;
  }
  await generateButton(page).waitFor({state: 'visible', timeout: 45_000}).catch(() => {
    throw new Error('Fish Audio の読み上げ画面を開けませんでした（生成ボタンが見つかりません）。「窓を出して動かす」にして、確認画面が出ていないか見てください');
  });
  await page.waitForTimeout(600);
  await dismissPromos(page);
};

// ───────────────────────── 設定パネル（モデル・速度・音量） ─────────────────────────

const ensureSettingsPanel = async (page: Page) => {
  if (await modelSelector(page).isVisible().catch(() => false)) return;
  await page.locator('button[aria-label="Open voice settings"]').first().click({timeout: 10_000});
  await modelSelector(page).waitFor({state: 'visible', timeout: 10_000});
};

const selectModel = async (page: Page, modelId: string): Promise<string> => {
  const want = WEB_MODEL_LABEL[modelId];
  if (!want) throw new Error(`このモデルは Web 画面の選択肢に対応づけていません: ${modelId}（Drama 3 / S2.1 Pro / S2 Pro / S1 から選んでください）`);
  const sel = modelSelector(page);
  const current = ((await sel.innerText()) ?? '').replace(/\s+/g, ' ');
  if (want.test(current)) return current;
  await sel.click();
  const opt = page.locator('[role="option"]').filter({hasText: want}).first();
  await opt.waitFor({state: 'visible', timeout: 8_000}).catch(() => {
    throw new Error(`Web 画面のモデル選択に ${modelId} にあたる項目が見つかりません`);
  });
  await opt.click();
  await page.waitForTimeout(400);
  const after = ((await sel.innerText()) ?? '').replace(/\s+/g, ' ');
  if (!want.test(after)) throw new Error(`Web 画面のモデルを ${modelId} に切り替えられませんでした（いま: ${after}）。プランで使えないモデルの可能性があります`);
  return after;
};

/**
 * スライダーを矢印キーで目標値に寄せる。Web 画面の範囲（速度は 0.7〜1.3）を超える分は丸める。
 * 返すのは実際に入った値（足りない分は呼び出し側が ffmpeg で補う）
 */
const setSlider = async (page: Page, label: string, index: number, target: number): Promise<number> => {
  const byLabel = page.locator(`[role="slider"][aria-label="${label}"]`);
  const thumb = (await byLabel.count()) ? byLabel.first() : page.locator('[role="dialog"] [role="slider"]').nth(index);
  const num = async (attr: string) => Number(await thumb.getAttribute(attr));
  const [min, max] = [await num('aria-valuemin'), await num('aria-valuemax')];
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error(`Web 画面の「${label}」のつまみを読めませんでした`);
  const goal = Math.min(max, Math.max(min, target));
  await thumb.focus();
  let cur = await num('aria-valuenow');
  for (let i = 0; i < 120 && Math.abs(cur - goal) > 1e-6; i++) {
    const key = cur < goal ? 'ArrowRight' : 'ArrowLeft';
    await page.keyboard.press(key);
    const next = await num('aria-valuenow');
    // 動かない・目標を跨いだら、近い方で止める
    if (next === cur) break;
    if ((cur < goal && next > goal) || (cur > goal && next < goal)) {
      if (Math.abs(cur - goal) < Math.abs(next - goal)) await page.keyboard.press(key === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight');
      cur = await num('aria-valuenow');
      break;
    }
    cur = next;
  }
  return cur;
};

// ───────────────────────── 本文の入力と生成 ─────────────────────────

const typeText = async (page: Page, text: string) => {
  const ed = editor(page);
  await ed.waitFor({state: 'visible', timeout: 10_000}).catch(() => {
    throw new Error('Web 画面に本文の入力欄が出ません。このボイスを Web 画面で選べなかった可能性があります（消された・非公開のボイス）');
  });
  await ed.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    if (line) await page.keyboard.insertText(line);
  }
  await page.waitForTimeout(200);
  const typed = ((await ed.innerText()) ?? '').replace(/\s+/g, '');
  if (!typed) throw new Error('Web 画面の入力欄に本文が入りませんでした');
};

type Seen = {status: number; type: string; url: string; bytes?: number};
const AUDIO_URL = /\.(mp3|wav|opus|ogg|m4a|aac|flac)(\?|$)/i;
const isAudio = (r: Response): boolean => {
  const type = (r.headers()['content-type'] ?? '').toLowerCase();
  return type.startsWith('audio/') || (AUDIO_URL.test(r.url()) && !type.startsWith('text/'));
};
const bare = (url: string) => url.split('?')[0].slice(0, 160);

const dumpDebug = async (page: Page, reason: string, seen: Seen[]): Promise<string> => {
  try {
    fs.mkdirSync(debugDir(), {recursive: true});
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(debugDir(), stamp);
    await page.screenshot({path: `${base}.png`}).catch(() => {});
    const dialogs = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="alert"],[data-sonner-toast]')].map((d) => (d as HTMLElement).innerText.slice(0, 400))).catch(() => []);
    // 通信はクエリを落とした URL と種類だけ（Cookie・ヘッダー・本文は残さない）
    fs.writeFileSync(`${base}.json`, JSON.stringify({reason, url: bare(page.url()), dialogs, responses: seen.slice(-80)}, null, 2));
    return `${base}.json`;
  } catch {
    return debugDir();
  }
};

/** 画面に出ている音声（audio 要素・ダウンロードのリンク）をページの中から取りにいく（通信で拾えなかったとき用） */
const audioFromDom = async (page: Page, before: string[]): Promise<Buffer | null> => {
  const b64 = await page
    .evaluate(async (known) => {
      const srcs = [...document.querySelectorAll('audio')].map((a) => a.currentSrc || a.src).concat([...document.querySelectorAll('a[download]')].map((a) => (a as HTMLAnchorElement).href));
      const src = srcs.filter((s) => s && !known.includes(s)).pop();
      if (!src) return null;
      try {
        const buf = new Uint8Array(await (await fetch(src)).arrayBuffer());
        if (buf.length < 1000) return null;
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(bin);
      } catch {
        return null;
      }
    }, before)
    .catch(() => null);
  return b64 ? Buffer.from(b64, 'base64') : null;
};

const generate = async (page: Page, signal?: AbortSignal): Promise<Buffer> => {
  const seen: Seen[] = [];
  const bodies: Promise<void>[] = [];
  const got: {best: Buffer | null; at: number} = {best: null, at: 0};
  let lastDomCheck = 0;
  const onResponse = (r: Response) => {
    const url = r.url();
    if (!/fish\.audio/i.test(url) || /\.(js|css|woff2?|png|jpe?g|webp|svg|ico)(\?|$)/i.test(url)) return;
    const entry: Seen = {status: r.status(), type: r.headers()['content-type'] ?? '', url: bare(url)};
    seen.push(entry);
    if (!isAudio(r) || r.status() >= 400) return;
    bodies.push(
      r.body().then(
        (buf) => {
          entry.bytes = buf.length;
          got.at = Date.now();
          if (buf.length > 1000 && (!got.best || buf.length > got.best.length)) got.best = buf;
        },
        () => {},
      ),
    );
  };
  const domBefore = await page.evaluate(() => [...document.querySelectorAll('audio')].map((a) => a.currentSrc || a.src).concat([...document.querySelectorAll('a[download]')].map((a) => (a as HTMLAnchorElement).href))).catch(() => [] as string[]);
  page.on('response', onResponse);
  try {
    await generateButton(page).click({timeout: 10_000});
    const started = Date.now();
    for (;;) {
      aborted(signal);
      await page.waitForTimeout(700);
      if (await authDialogOpen(page)) throw new Error(FISH_WEB_LOGIN_NEEDED);
      // 音声が届いてから少し待つ（分割して届く場合に、最後まで受け取る）
      if (got.best && Date.now() - got.at > 1800) {
        await Promise.allSettled(bodies);
        return got.best;
      }
      const waited = Date.now() - started;
      if (!got.best && waited > 6000 && Date.now() - lastDomCheck > 2000) {
        lastDomCheck = Date.now();
        const fromDom = await audioFromDom(page, domBefore);
        if (fromDom) return fromDom;
      }
      if (waited > GENERATE_TIMEOUT_MS) break;
    }
    const file = await dumpDebug(page, 'timeout', seen);
    throw new Error(`Web 画面で生成した音声を受け取れませんでした（${Math.round(GENERATE_TIMEOUT_MS / 1000)} 秒待ちました）。クレジット切れ・画面の変更・確認画面の可能性があります。記録: ${file}`);
  } catch (e) {
    if (e instanceof Error && !/記録: |中断されました|ログインしていません/.test(e.message)) {
      const file = await dumpDebug(page, e.message.slice(0, 200), seen);
      throw new Error(`${e.message}（記録: ${file}）`);
    }
    throw e;
  } finally {
    page.off('response', onResponse);
  }
};

/** Web 画面が返す音声（mp3 など）を、案件が使う wav（44.1kHz・モノラル）にする。tempo は Web 画面で足りなかった速度の分 */
const toWav = async (audio: Buffer, tempo: number): Promise<Buffer> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-fish-web-'));
  try {
    const src = path.join(dir, 'in.bin');
    const out = path.join(dir, 'out.wav');
    fs.writeFileSync(src, audio);
    const filter = Math.abs(tempo - 1) > 0.01 ? ['-af', `atempo=${Math.min(2, Math.max(0.5, tempo)).toFixed(4)}`] : [];
    await execOk('ffmpeg', ['-y', '-v', 'error', '-i', src, ...filter, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', out]);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
};

/** 開いた読み上げ画面に、モデル・速度・音量・本文を入れる（生成ボタンを押す直前まで）。返すのは実際に入った値 */
export const prepareFishWebPage = async (page: Page, req: FishWebRequest): Promise<{model: string; webSpeed: number; webVolume: number}> => {
  // お知らせは遅れて出ることがあり、出ている間は下の部品を押せない
  await dismissPromos(page);
  await ensureSettingsPanel(page);
  await dismissPromos(page);
  const model = await selectModel(page, req.modelId);
  const webSpeed = await setSlider(page, '速度', 1, req.speed);
  const webVolume = await setSlider(page, 'ボリューム', 0, req.volume);
  await dismissPromos(page);
  await typeText(page, req.text);
  return {model, webSpeed, webVolume};
};

/** 1 ブロック分を Web 画面で作って wav で返す */
export const synthViaWeb = (req: FishWebRequest, opt: {signal?: AbortSignal} = {}): Promise<Buffer> =>
  enqueue(async () => {
    aborted(opt.signal);
    const s = await acquire();
    try {
      await openPage(s, req.voiceId);
      if (await loggedOut(s.page)) throw new Error(FISH_WEB_LOGIN_NEEDED);
      aborted(opt.signal);
      const {webSpeed} = await prepareFishWebPage(s.page, req);
      aborted(opt.signal);
      const audio = await generate(s.page, opt.signal);
      return await toWav(audio, webSpeed > 0 ? req.speed / webSpeed : 1);
    } catch (e) {
      // 画面が半端な状態で残らないよう、次は開き直す
      if (session) session.voiceId = null;
      throw e;
    } finally {
      release();
    }
  });

// ───────────────────────── ログインと状態確認（Settings 用） ─────────────────────────

export type FishWebStatus = {ok: boolean; loggedIn: boolean | null; browser: string | null; loginWindowOpen: boolean; message: string};

/** 窓を出して fish.audio を開く。ログインは人がする（終わったら窓を閉じるか、そのまま生成を始めてよい） */
export const openFishWebLogin = (): Promise<FishWebStatus> =>
  enqueue(async () => {
    await closeSession();
    await closeLogin();
    const {ctx, channel} = await launch(false);
    loginCtx = ctx;
    ctx.on('close', () => {
      if (loginCtx === ctx) loginCtx = null;
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(TTS_URL, {waitUntil: 'domcontentloaded', timeout: 60_000}).catch(() => {});
    return {ok: true, loggedIn: null, browser: channel, loginWindowOpen: true, message: 'ログイン用の窓を開きました。fish.audio にログインしたら「ログイン状態を確認」を押してください'};
  });

/** いまログインできているか。ログイン用の窓が開いていればそこで、無ければ裏で開いて確かめる */
export const fishWebStatus = (): Promise<FishWebStatus> =>
  enqueue(async () => {
    try {
      if (loginCtx) {
        const page = loginCtx.pages().find((p) => p.url().includes('fish.audio')) ?? loginCtx.pages()[0];
        if (!page) return {ok: false, loggedIn: null, browser: null, loginWindowOpen: true, message: 'ログイン用の窓にページがありません。窓を閉じてやり直してください'};
        if (!page.url().startsWith(TTS_URL)) return {ok: false, loggedIn: null, browser: null, loginWindowOpen: true, message: 'ログインの途中です。終わってからもう一度押してください'};
        await generateButton(page).waitFor({state: 'visible', timeout: 20_000});
        const out = await loggedOut(page);
        if (!out) await closeLogin();
        return {ok: !out, loggedIn: !out, browser: null, loginWindowOpen: out, message: out ? 'まだログインしていません。開いている窓でログインしてください' : 'ログインを確認しました。窓は閉じました'};
      }
      const s = await acquire();
      try {
        s.voiceId = null;
        await s.page.goto(TTS_URL, {waitUntil: 'domcontentloaded', timeout: 60_000});
        await generateButton(s.page).waitFor({state: 'visible', timeout: 45_000});
        await s.page.waitForTimeout(800);
        const out = await loggedOut(s.page);
        return {ok: !out, loggedIn: !out, browser: s.channel, loginWindowOpen: false, message: out ? FISH_WEB_LOGIN_NEEDED : `ログイン済みです（${s.channel === 'msedge' ? 'Edge' : 'Chrome'}${s.headless ? '・裏で動かす' : '・窓を出す'}）`};
      } finally {
        release();
      }
    } catch (e) {
      return {ok: false, loggedIn: null, browser: null, loginWindowOpen: !!loginCtx, message: `確認できませんでした: ${(e as Error).message.split('\n')[0]}`};
    }
  });
