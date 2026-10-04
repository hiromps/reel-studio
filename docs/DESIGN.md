# Reel Studio デザイン — 他プロジェクトで再現するための仕様書

> 対象: 2026-10-02 のライト基調の新デザイン（コミット `86b0ee8`「画面をライト基調の新デザインに刷新する」以降）。
> 正本は `src/styles.css`（冒頭のトークン）と `src/theme.ts`。この文書の値はそこから写したもの。
> 値を変えたら、この文書も直すこと。

この文書だけで同じ見た目を再現できるように、**そのまま貼れる CSS とコード**を載せている。
§3〜§5 をこの順でファイルに貼れば、土台・部品・テーマ切り替えまで揃う。

---

## 1. トンマナ（ひと言で）

**「明るいグレーの地に、白い角丸パネルを浮かせる」道具のための UI。**

| 観点 | 方針 |
|---|---|
| 地と面 | 地は青みのある薄いグレー `#eef0f4`。中身はすべて白いパネル（角丸 16px・1px の薄い線・ごく弱い影）に載せる。地の上に直接文字を置かない |
| 色の使い方 | 本文はほぼ無彩色。色は **意味があるときだけ** 使う（青＝操作・選択、緑＝完了、橙＝注意、赤＝エラー、紫＝テキスト系）。状態は「淡い下地＋濃い同系色の文字」のチップで出す |
| 主役の色 | アクセントは青 `#1a73ff` の 1 色だけ。ブランドの印（ロゴ）と「Claude に頼む」だけがオレンジのグラデーション |
| 形 | 角丸が基本。パネル 16px / 入力・ボタン 10px / ピル・バッジ 999px / 丸ボタン 50% |
| 厚み | ボタンは**下辺だけ少し濃い**（`inset 0 -2px 0`）。押すと 1px 沈む。フラットだが「押せる」ことは分かる |
| 見出し | パネルの見出しは**小さな大文字ラベル**（12px・600・字間 0.06em・グレー）。大きな見出しは使わない |
| 密度 | 本文 13px。道具なので詰め気味。余白は 14px を基準に 4 / 6 / 8 / 10 / 12 / 14 / 16 |
| 動き | 0.12s の短いトランジションだけ。常時アニメは「作業中」の表示に限り、`prefers-reduced-motion` で必ず止める |
| ダーク | 同じ構造のまま色トークンだけ差し替える。既定はライト、右上の月のボタンで切り替え・記憶 |

### やらないこと

- 部品の CSS に色を直書きしない（`#fff` / `#000` の固定は「青や黒の上の白文字」など意図がある箇所だけ）
- 太い枠線・濃い影・グラデーションの背景を面に使わない（グラデーションはブランド印・AI ボタン・タイムラインのピルだけ）
- 色だけで状態を伝えない（チップには必ず文字を入れる）

---

## 2. デザイントークン

### 2.1 色（ライト / ダーク）

| トークン | ライト | ダーク | 用途 |
|---|---|---|---|
| `--bg` | `#eef0f4` | `#0f1114` | ページの地。`theme-color`（ブラウザのバー）もこれに合わせる |
| `--panel` | `#ffffff` | `#191c21` | パネル・カード・ポップアップの面 |
| `--panel2` | `#f2f3f6` | `#22262d` | パネルの中の一段沈んだ面（コード・補足枠） |
| `--line` | `#e4e6eb` | `#2c3139` | 境界線・区切り |
| `--fg` | `#1d2026` | `#e8eaed` | 本文 |
| `--muted` | `#8b919c` | `#8f98a3` | 補足・ラベル・非選択のタブ |
| `--accent` / `--accent2` | `#1a73ff` | `#4b93ff` | 操作・選択・リンク・フォーカス |
| `--accent-soft` | `rgba(26,115,255,.10)` | `rgba(75,147,255,.14)` | フォーカスリング・選択中の淡い下地 |
| `--ok` | `#1fae6b` | `#4cc38a` | 完了 |
| `--warn` | `#e8890c` | `#f0a941` | 注意 |
| `--err` | `#ef4444` | `#ff6b6b` | エラー |
| `--btn` / `--btn-hover` | `#ececf0` / `#e2e3e8` | `#262a31` / `#2e333b` | 通常ボタンの面 |
| `--btn-edge` | `rgba(15,20,30,.10)` | `rgba(0,0,0,.45)` | ボタン下辺の厚み |
| `--input` | `#f2f3f6` | `#22262d` | 入力欄の面（枠線なし。フォーカスで白＋青枠） |
| `--chip` | `#eceef2` | `#2a2f37` | タブの溝・ピル・アイコンボタンのホバー |
| `--hover` | `rgba(15,20,30,.04)` | `rgba(255,255,255,.04)` | 行のホバー |
| `--sel-bg` | `#e8f1ff` | `#1d2a3d` | 選択中の行 |
| `--code-bg` | `#f6f7f9` | `#0d0f12` | コードブロック |
| `--veil` | `rgba(255,255,255,.94)` | `rgba(18,20,23,.92)` | 映像の上に重ねる覆い |
| `--backdrop` | `rgba(20,24,32,.32)` | `rgba(0,0,0,.55)` | モーダルの後ろ |
| `--dot` | `#d5d8de` | `#2b3038` | 方眼キャンバスの点 |

**状態のチップ（淡い下地 `--tint-*` ＋ 文字 `--tint-*-fg`）**

| 色 | ライト 下地 / 文字 | ダーク 下地 / 文字 | 意味 |
|---|---|---|---|
| blue | `#e3eeff` / `#1b62d6` | `#1c2a40` / `#9cc4ff` | 実行中・使用中・これから |
| green | `#dcf4e7` / `#12804c` | `#16301f` / `#6fd9a2` | 完了・準備できた |
| yellow | `#fff3d1` / `#93620a` | `#3a3115` / `#ffd966` | 仮の値・目立たせたい印 |
| orange | `#ffe9d6` / `#b85a0b` | `#3a2615` / `#ffb366` | 注意・未処理・未保存 |
| red | `#ffe3e3` / `#c92a2a` | `#3a1d1d` / `#ff8a8a` | エラー・不可・削除 |
| purple | `#eee5ff` / `#6d3fd6` | `#2c2242` / `#c9a8ff` | 特殊な処理（顔モザイク等） |

**段（トラック）の色** — 種類の違うものを並べるときの識別色（ライト・ダーク共通）

| トークン | 値 | 種類 |
|---|---|---|
| `--trk-video` | `#3b82f6` | 映像（青） |
| `--trk-telop` | `#8b5cf6` | テキスト（紫） |
| `--trk-narr` | `#22b573` | 音声（緑） |
| `--trk-sfx` | `#f59331` | 効果音（橙） |

**ブランド色**（トークン外の固定値。ここだけはテーマで変えない）

- ブランド印: `linear-gradient(135deg, #ff7a3d, #ff4d1a)`、影 `0 2px 6px rgba(255,90,30,.35)`
- AI ボタン: `linear-gradient(180deg, #ff6a2b, #f24d12)`、ホバー `#ff7a40 → #e5450d`
- 再生ボタン: ライトは黒 `#15171b`（ホバー `#2a2d33`）、ダークは白 `#fff` に反転

### 2.2 形・影・文字

| トークン | 値 |
|---|---|
| `--radius` | `16px`（パネル） |
| `--radius-sm` | `10px`（入力・ボタン） |
| その他の角丸 | ピル・バッジ `999px` / 小ボタン `8px` / タブ溝 `12px`・タブ `9px` / サムネ `8–10px` / 丸ボタン `50%` |
| `--shadow-sm` | `0 1px 2px rgba(15,20,30,.06), 0 1px 1px rgba(15,20,30,.04)`（常時のパネル） |
| `--shadow-md` | `0 4px 14px rgba(15,20,30,.08), 0 1px 3px rgba(15,20,30,.06)`（ホバー・浮いた部品・トースト） |
| `--shadow-lg-c` | `rgba(15,20,30,.18)`（色だけ。`0 14px 40px var(--shadow-lg-c)` でポップアップ、`0 18px 50px` でモーダル） |
| 書体 | `'Inter', 'Segoe UI Variable Text', 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', system-ui, sans-serif`（Web フォントは読み込まない。入っていれば Inter） |
| 等幅 | `Consolas, monospace`（ID・パス・ログ） |
| 数字 | 時刻・カウンタは `font-variant-numeric: tabular-nums` |
| 基本サイズ | 13px（狭い画面は 14px）。補足 12px、ラベル 11–12px、バッジ 10px |
| 太さ | 本文 400 / ボタン 500 / 見出しラベル・ピル 600 / ブランド・強調 700 |

### 2.3 文字サイズの段

| 用途 | サイズ / 太さ / その他 |
|---|---|
| ブランド名 | 15px / 700 / `letter-spacing: -0.01em` |
| パネル見出し（`h2`） | 12px / 600 / `0.06em` / UPPERCASE / `--muted` |
| 小見出し（`h3`） | 13px / 既定の bold |
| 本文 | 13px |
| 補足（`.hint`） | 12px / `--muted` |
| 表の見出し | 11px / 600 / `0.04em` / UPPERCASE / `--muted` |
| 再生時刻 | 16px / 600 / tabular-nums |

---

## 3. 貼るだけの CSS ①：トークン

```css
:root {
  color-scheme: light;
  --bg: #eef0f4;
  --panel: #ffffff;
  --panel2: #f2f3f6;
  --line: #e4e6eb;
  --fg: #1d2026;
  --muted: #8b919c;
  --accent: #1a73ff;
  --accent2: #1a73ff;
  --accent-soft: rgba(26, 115, 255, 0.1);
  --ok: #1fae6b;
  --warn: #e8890c;
  --err: #ef4444;
  --btn: #ececf0;
  --btn-hover: #e2e3e8;
  --btn-edge: rgba(15, 20, 30, 0.1);
  --input: #f2f3f6;
  --chip: #eceef2;
  --hover: rgba(15, 20, 30, 0.04);
  --sel-bg: #e8f1ff;
  --code-bg: #f6f7f9;
  --veil: rgba(255, 255, 255, 0.94);
  --backdrop: rgba(20, 24, 32, 0.32);
  --shadow-sm: 0 1px 2px rgba(15, 20, 30, 0.06), 0 1px 1px rgba(15, 20, 30, 0.04);
  --shadow-md: 0 4px 14px rgba(15, 20, 30, 0.08), 0 1px 3px rgba(15, 20, 30, 0.06);
  --shadow-lg-c: rgba(15, 20, 30, 0.18);
  --dot: #d5d8de;
  --tint-blue: #e3eeff;
  --tint-blue-fg: #1b62d6;
  --tint-green: #dcf4e7;
  --tint-green-fg: #12804c;
  --tint-yellow: #fff3d1;
  --tint-yellow-fg: #93620a;
  --tint-orange: #ffe9d6;
  --tint-orange-fg: #b85a0b;
  --tint-red: #ffe3e3;
  --tint-red-fg: #c92a2a;
  --tint-purple: #eee5ff;
  --tint-purple-fg: #6d3fd6;
  --trk-video: #3b82f6;
  --trk-telop: #8b5cf6;
  --trk-narr: #22b573;
  --trk-sfx: #f59331;
  --radius: 16px;
  --radius-sm: 10px;
  font-family: 'Inter', 'Segoe UI Variable Text', 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', system-ui, sans-serif;
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}
:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #0f1114;
  --panel: #191c21;
  --panel2: #22262d;
  --line: #2c3139;
  --fg: #e8eaed;
  --muted: #8f98a3;
  --accent: #4b93ff;
  --accent2: #4b93ff;
  --accent-soft: rgba(75, 147, 255, 0.14);
  --ok: #4cc38a;
  --warn: #f0a941;
  --err: #ff6b6b;
  --btn: #262a31;
  --btn-hover: #2e333b;
  --btn-edge: rgba(0, 0, 0, 0.45);
  --input: #22262d;
  --chip: #2a2f37;
  --hover: rgba(255, 255, 255, 0.04);
  --sel-bg: #1d2a3d;
  --code-bg: #0d0f12;
  --veil: rgba(18, 20, 23, 0.92);
  --backdrop: rgba(0, 0, 0, 0.55);
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-md: 0 6px 18px rgba(0, 0, 0, 0.4);
  --shadow-lg-c: rgba(0, 0, 0, 0.65);
  --dot: #2b3038;
  --tint-blue: #1c2a40;
  --tint-blue-fg: #9cc4ff;
  --tint-green: #16301f;
  --tint-green-fg: #6fd9a2;
  --tint-yellow: #3a3115;
  --tint-yellow-fg: #ffd966;
  --tint-orange: #3a2615;
  --tint-orange-fg: #ffb366;
  --tint-red: #3a1d1d;
  --tint-red-fg: #ff8a8a;
  --tint-purple: #2c2242;
  --tint-purple-fg: #c9a8ff;
}
```

> Tailwind で使う場合は、上の `:root` をそのまま global CSS に置き、`theme.extend.colors` に
> `bg: 'var(--bg)', panel: 'var(--panel)', ...` のように **var() を参照させる**（16 進を Tailwind 側に複製しない）。
> Tailwind v4 なら `@theme inline { --color-panel: var(--panel); ... }`。

---

## 4. 貼るだけの CSS ②：土台の要素

素のタグ（`button` / `input` / `label`）に直接スタイルを当てる方式。クラスを付けなくても全体のトンマナが揃う。

```css
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); }
button, input, select, textarea { font: inherit; color: inherit; }

/* 入力欄：枠線なしの淡い面 → フォーカスで白い面＋青い枠＋淡い青のリング */
input, select, textarea {
  background: var(--input);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  transition: border-color 0.12s, box-shadow 0.12s, background 0.12s;
}
input:focus, select:focus, textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  background: var(--panel);
}
input[type='checkbox'], input[type='radio'] { accent-color: var(--accent); box-shadow: none; }
input[type='range'] { accent-color: var(--accent); background: transparent; padding: 0; }
input[type='number'] { width: 84px; }
textarea { width: 100%; min-height: 60px; }
/* iPhone の Safari で長い option が親を横に押し広げるのを防ぐ */
select { max-width: 100%; contain: layout; }

/* ボタン：淡いグレーの面、下辺だけ濃くして厚みを出す。押すと 1px 沈む */
button {
  background: var(--btn);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 6px 12px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: inset 0 -2px 0 var(--btn-edge);
  transition: background 0.12s, box-shadow 0.12s, transform 0.06s;
}
button:hover { background: var(--btn-hover); }
button:active:not(:disabled) { transform: translateY(1px); box-shadow: inset 0 -1px 0 var(--btn-edge); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button:disabled { opacity: 0.45; cursor: default; }
button.primary {
  background: var(--accent);
  color: #fff;
  box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.18), 0 2px 6px rgba(26, 115, 255, 0.25);
}
button.primary:hover { background: color-mix(in srgb, var(--accent) 88%, #000); }
button.small { padding: 3px 9px; font-size: 12px; border-radius: 8px; }
button.warn { background: var(--tint-orange); color: var(--tint-orange-fg); }
button.danger { background: var(--tint-red); color: var(--tint-red-fg); }

/* ラベルは「小さなグレーの文字の下に入力欄」の縦積み */
label { display: inline-flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); }
label > input, label > select, label > textarea { color: var(--fg); }
/* チェックボックスだけは文字の横に（:where で詳細度 0） */
label:where(:has(> input[type='checkbox']), :has(> input[type='radio'])) {
  flex-direction: row; align-items: center; gap: 6px;
}

.hint { color: var(--muted); font-size: 12px; }
.dim { color: var(--muted); }
.mono { font-family: Consolas, monospace; }
```

---

## 5. 貼るだけの CSS ③：部品

### 5.1 レイアウト・パネル

```css
.app { display: flex; flex-direction: column; min-height: 100vh; }
.main { flex: 1; padding: 4px 14px 14px; }
.page { display: flex; flex-direction: column; gap: 14px; }

/* 白い角丸パネル。すべての中身はこれに載せる */
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 16px;
  box-shadow: var(--shadow-sm);
}
/* 見出しは小さな大文字ラベル */
.card h2 {
  margin: 0 0 12px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.card h3 { margin: 10px 0 6px; font-size: 13px; }

/* 横並びの行。中身は縮めて、画面外へはみ出させない */
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.row > * { min-width: 0; }
.row > h2 { align-self: center; }
.form { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.form > * { min-width: 0; }
.form .full { grid-column: 1 / -1; }
```

### 5.2 上部バー・ブランド・タブ

上部バーは**パネルにしない**。地の色を半透明＋ぼかしで敷き、部品（タブの溝・白いセレクト）だけを置く。

```css
.topbar {
  display: flex; align-items: center; gap: 14px;
  padding: 10px 14px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(10px);
  position: sticky; top: 0; z-index: 10;
}
.brand {
  display: inline-flex; align-items: center; gap: 8px;
  font-weight: 700; font-size: 15px; letter-spacing: -0.01em;
  color: var(--fg); white-space: nowrap;
}
/* オレンジの角丸の印（中は ▶） */
.brand-mark {
  width: 26px; height: 26px; border-radius: 8px;
  display: inline-grid; place-items: center;
  background: linear-gradient(135deg, #ff7a3d, #ff4d1a);
  color: #fff; font-size: 13px;
  box-shadow: 0 2px 6px rgba(255, 90, 30, 0.35);
}

/* セグメント切り替え：グレーの溝の中で、選択中だけ白いピルが浮く */
.tabs { display: flex; gap: 2px; padding: 3px; background: var(--chip); border-radius: 12px; }
.tab {
  background: transparent; border: 1px solid transparent; box-shadow: none;
  border-radius: 9px; padding: 5px 12px; color: var(--muted);
}
.tab:hover { background: transparent; color: var(--fg); }
.tab.active { background: var(--panel); color: var(--fg); box-shadow: var(--shadow-sm); }
.tab-sub { margin-left: 4px; font-size: 10px; color: var(--muted); }
.tab.active .tab-sub { color: var(--fg); }

/* 丸いアイコンボタン（? ヘルプ・☾ テーマ）。普段は透明、ホバーで溝の色 */
.icon-btn {
  width: 34px; height: 34px; padding: 0;
  display: inline-grid; place-items: center;
  border-radius: 50%; background: transparent; box-shadow: none;
  color: var(--muted); font-size: 16px; flex: 0 0 auto;
}
.icon-btn:hover { background: var(--chip); color: var(--fg); }
.topbar .icon-btn { order: 5; }

/* 右端の状態エリア。セレクトは白く浮かせる */
.status { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.status select { background: var(--panel); box-shadow: var(--shadow-sm); font-weight: 600; }
.status .pill { white-space: nowrap; }
```

構造（React の例）:

```tsx
<header className="topbar">
  <div className="brand"><span className="brand-mark" aria-hidden="true">▶</span>Reel Studio</div>
  <nav className="tabs">
    <button className="tab active">Brief<span className="tab-sub">企画</span></button>
    <button className="tab">Materials<span className="tab-sub">素材</span></button>
  </nav>
  <button className="icon-btn" aria-label="使い方">?</button>
  <button className="icon-btn theme-btn" aria-label="配色を切り替える">☾</button>
  <div className="status">…</div>
</header>
```

### 5.3 ピル・バッジ・トースト・表

```css
/* 状態のピル（淡い下地＋同系色の文字） */
.pill { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; background: var(--chip); }
.pill.run  { background: var(--tint-blue);   color: var(--tint-blue-fg); }
.pill.ok   { background: var(--tint-green);  color: var(--tint-green-fg); }
.pill.warn { background: var(--tint-orange); color: var(--tint-orange-fg); }
/* 見落とすと困る警告だけは塗りつぶし */
.pill.err  { color: #fff; background: var(--err); font-weight: 700; }

/* 小さなバッジ（カードの上のタグ） */
.badges { display: flex; gap: 4px; flex-wrap: wrap; }
.badge { font-size: 10px; font-weight: 600; padding: 1px 7px; border-radius: 999px; background: var(--chip); }
.badge.hook { background: var(--tint-yellow); color: var(--tint-yellow-fg); }
.badge.ng   { background: var(--tint-red);    color: var(--tint-red-fg); }
.badge.sign { background: var(--tint-green);  color: var(--tint-green-fg); }

/* 右下のトースト。左端の太線で種類を見せる */
.toasts { position: fixed; right: 14px; bottom: 14px; display: flex; flex-direction: column; gap: 8px; z-index: 50; }
.toast {
  background: var(--panel); border: 1px solid var(--line);
  border-left: 4px solid var(--accent2);
  padding: 10px 14px; border-radius: 12px; max-width: 420px;
  box-shadow: var(--shadow-md);
}
.toast.ok { border-left-color: var(--ok); }
.toast.error { border-left-color: var(--err); }

/* 表：見出しは小さな大文字、行は細線で区切り、ホバーで淡く */
.table { width: 100%; border-collapse: collapse; }
.table th { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.table th, .table td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.table tbody tr:hover { background: var(--hover); }
.table tr.active { background: var(--sel-bg); }
```

### 5.4 「次にやること」バー

画面上部に 1 本だけ出す案内。左に青いタグ、準備ができたら全体が淡い緑・タグが緑になる。

```css
.nextbar {
  display: flex; align-items: center; gap: 10px;
  margin: 0 14px 10px; padding: 6px 8px 6px 6px;
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 14px; box-shadow: var(--shadow-sm); font-size: 12px;
}
.nextbar.ready { background: var(--tint-green); border-color: transparent; }
.nextbar-tag { flex: 0 0 auto; padding: 3px 10px; border-radius: 999px; background: var(--accent2); color: #fff; font-weight: 700; }
.nextbar.ready .nextbar-tag { background: var(--ok); }
.nextbar-text { flex: 1; min-width: 0; }
.nextbar-x { background: transparent; box-shadow: none; border-color: transparent; color: var(--muted); }
```

### 5.5 選べるカード（サムネイル一覧）

```css
.clip-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.clip-card {
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  padding: 6px; cursor: pointer; box-shadow: var(--shadow-sm);
  transition: box-shadow 0.12s, border-color 0.12s;
}
.clip-card:hover { box-shadow: var(--shadow-md); }
/* 選択＝青い枠＋淡い青のリング（フォーカスと同じ見せ方） */
.clip-card.selected { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.clip-card.ng { opacity: 0.45; }
.clip-card img { width: 100%; height: 90px; object-fit: cover; border-radius: 10px; background: #000; }
.clip-card .meta { font-size: 11px; color: var(--muted); margin-top: 4px; display: flex; justify-content: space-between; }
```

サムネイルの上に重ねる小さなラベルは、テーマに関係なく黒の半透明に白文字: `background: rgba(0,0,0,.72); color: #fff; font-size: 10px; border-radius: 6px;`

### 5.6 モーダル・ポップアップ

```css
.modal-root {
  position: fixed; inset: 0; z-index: 250;
  background: var(--backdrop);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 48px 16px;
}
.modal {
  width: min(820px, 100%); max-height: 100%;
  display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px;            /* 現状 8px。パネルに揃えるなら var(--radius) */
  box-shadow: 0 18px 50px var(--shadow-lg-c);
}
.modal-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.modal-head b { color: var(--accent); font-size: 14px; }   /* モーダルの題は青 */
.modal-body { padding: 10px 14px 16px; overflow: auto; line-height: 1.7; }
.modal-body h3 { margin: 14px 0 4px; font-size: 13px; color: var(--accent); }

/* ボタン直下の吹き出し（メニュー） */
.pop {
  position: absolute; left: 0; top: calc(100% + 6px); z-index: 40;
  width: 460px; max-width: calc(100vw - 32px);
  /* 中身は .card を使う */
  box-shadow: 0 14px 40px var(--shadow-lg-c);
}

/* 読み込み中のくるくる（青い弧） */
.spinner::before {
  content: ''; display: inline-block; width: 12px; height: 12px; margin-right: 8px; vertical-align: -1px;
  border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner::before { animation: none; } }
```

### 5.7 「Claude に頼む」ボタン（目玉付きのオレンジのピル）

AI に依頼する入口はこの 1 種類だけ。作業中は黒目が左右に動く。

```css
.ai-btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 12px 6px 8px; border-radius: 999px;
  background: linear-gradient(180deg, #ff6a2b, #f24d12);
  color: #fff; font-weight: 700;
  box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.18), 0 4px 12px rgba(242, 77, 18, 0.3);
}
.ai-btn:hover { background: linear-gradient(180deg, #ff7a40, #e5450d); }
.ai-btn.on { box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.18), 0 0 0 3px rgba(242, 77, 18, 0.25); }
.ai-eyes { display: inline-flex; gap: 2px; }
.ai-eyes i { width: 14px; height: 14px; border-radius: 50%; background: #fff; position: relative; }
.ai-eyes i::after {
  content: ''; position: absolute; width: 7px; height: 7px; border-radius: 50%;
  background: #15171b; left: 4px; top: 4px;
}
.ai-btn.busy .ai-eyes i::after { animation: ai-look 1.6s ease-in-out infinite; }
@keyframes ai-look { 0%, 100% { left: 2px; } 50% { left: 6px; } }
@media (prefers-reduced-motion: reduce) { .ai-btn.busy .ai-eyes i::after { animation: none; } }
.ai-caret { font-size: 10px; opacity: 0.8; }
```

```html
<button class="ai-btn"><span class="ai-eyes"><i></i><i></i></span>Claude に頼む<span class="ai-caret">▾</span></button>
```

### 5.8 方眼のキャンバス（プレビューを浮かせる面）

プレビュー・作品を見せる中央の面は、白いパネルに 16px 間隔の点を打ち、作品を大きな影で浮かせる。

```css
.canvas {
  position: relative;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 16px; overflow: hidden;
  background-color: var(--panel);
  background-image: radial-gradient(var(--dot) 1px, transparent 1.2px);
  background-size: 16px 16px;
  background-position: 8px 8px;
  border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-sm);
}
.canvas-stage {
  border-radius: 14px; overflow: hidden; line-height: 0;
  box-shadow: 0 18px 40px rgba(15, 20, 30, 0.16), 0 2px 6px rgba(15, 20, 30, 0.08);
}
/* 左下に浮かせる小さな設定ピル（表示倍率・トグル類） */
.canvas-pill {
  position: absolute; left: 12px; bottom: 12px; max-width: calc(100% - 24px);
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px;
  padding: 6px 12px; background: var(--panel); border: 1px solid var(--line);
  border-radius: 12px; box-shadow: var(--shadow-md); font-size: 12px;
}
.canvas-pill-sep { width: 1px; height: 16px; background: var(--line); }
```

### 5.9 再生操作（黒い丸の再生ボタン）

並びは `時刻 ｜ ⏮ ◀ (●) ▶ ⏭ ｜ 全体の尺`。小ボタンは透明の丸、真ん中だけ黒い大きな丸。

```css
.transport { display: flex; align-items: center; gap: 6px; }
.tp-time, .tp-total { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; min-width: 62px; text-align: right; }
.tp-total { color: var(--muted); font-weight: 500; text-align: left; }
.tp-btn {
  width: 32px; height: 32px; padding: 0; display: inline-grid; place-items: center;
  border-radius: 50%; background: transparent; box-shadow: none; color: var(--fg);
}
.tp-btn:hover { background: var(--chip); }
.tp-play {
  width: 46px; height: 46px; padding: 0; display: inline-grid; place-items: center;
  border-radius: 50%; background: #15171b; color: #fff;
  box-shadow: 0 4px 12px rgba(15, 20, 30, 0.25);
}
.tp-play:hover { background: #2a2d33; }
.tp-play svg { width: 20px; height: 20px; }
:root[data-theme='dark'] .tp-play { background: #fff; color: #15171b; }
.tp-play.on { background: var(--accent); color: #fff; }
```

アイコンは線の SVG（`viewBox="0 0 24 24"`・`stroke="currentColor"`・`stroke-width="2"`・`round`）。再生だけ塗り。

```js
const ICON = {
  home: 'M6 5v14M19 5l-9 7 9 7z',
  end: 'M18 5v14M5 5l9 7-9 7z',
  back: 'M15 6l-6 6 6 6',
  fwd: 'M9 6l6 6-6 6',
  play: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
};
```

上段のツールバーは `grid-template-columns: 1fr auto 1fr`（左：件数／中央：再生／右：拡大と表示）で、再生を必ず中央に置く。

### 5.10 色分けした段（タイムライン）

左に「色付きの角丸アイコン＋名前」の段ラベル、右に段ごとの色のピルを並べる。

```css
/* 段ラベルのアイコン */
.tl-ico {
  width: 22px; height: 22px; border-radius: 7px;
  display: inline-grid; place-items: center;
  font-size: 11px; font-weight: 700; color: #fff;
  background: var(--trk-video);
  box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.15);
}
.tl-ico.t { background: var(--trk-telop); }
.tl-ico.n { background: var(--trk-narr); }
.tl-ico.s { background: var(--trk-sfx); }

/* テキスト段：グループ色を淡く敷いたチップ（--gcolor を要素ごとに渡す） */
.tl-telop {
  border-radius: 8px; padding: 0 10px; font-size: 12px; font-weight: 600;
  background: color-mix(in srgb, var(--gcolor, var(--trk-telop)) 22%, var(--panel));
  color: color-mix(in srgb, var(--gcolor, var(--trk-telop)) 55%, var(--fg));
}
/* 音声段：緑のグラデのピル＋両端のつまみ線 */
.tl-narr {
  border-radius: 8px; padding: 0 10px; font-size: 12px; font-weight: 600; color: #fff;
  background: linear-gradient(180deg, #2bc27e, var(--trk-narr));
  box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.12);
}
/* 効果音段：橙のグラデのピル */
.tl-sfx {
  border-radius: 7px; padding: 0 7px; font-size: 10px; font-weight: 600; color: #fff;
  background: linear-gradient(180deg, #ffa24d, var(--trk-sfx));
  box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.12);
}
/* 選択は種類を問わず青い外枠 */
.tl-telop.selected, .tl-narr.selected, .tl-sfx.selected { outline: 2px solid var(--accent); outline-offset: 1px; }
/* 中身が無い枠は点線 */
.tl-telop.none { background: transparent; border: 1px dashed var(--line); color: var(--muted); font-weight: 400; }

/* 再生ヘッド：青い 2px の線＋目盛りの上の角丸つまみ */
.tl-playhead { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--accent); z-index: 4; pointer-events: none; }
.tl-playhead::before {
  content: ''; position: absolute; top: 2px; left: -7px; width: 16px; height: 18px;
  border-radius: 6px; background: var(--accent); box-shadow: 0 2px 6px rgba(26, 115, 255, 0.4);
}
```

### 5.11 サイドパネル（インスペクタ）の区切り

```css
.insp-section { padding: 10px 0 14px; border-bottom: 1px solid var(--line); }
.insp-section:last-child { border-bottom: none; }
.insp-title {
  display: flex; align-items: center; gap: 6px; margin-bottom: 8px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted);
}
.insp-keys code { background: var(--panel2); padding: 0 4px; border-radius: 6px; color: var(--fg); }
```

### 5.12 3 カラムの編集画面

```css
.ed-main { display: grid; grid-template-columns: 236px minmax(200px, 1fr) 380px; gap: 10px; }
@media (max-width: 1280px) { .ed-main { grid-template-columns: 200px minmax(160px, 1fr) 330px; } }
/* 左（一覧）・中央（方眼キャンバス）・右（インスペクタ）はどれも白い角丸パネル */
.ed-bin, .ed-center, .ed-inspector {
  min-height: 0; background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: var(--shadow-sm);
}
.ed-inspector { overflow: auto; padding: 10px 14px; }
```

---

## 6. テーマ切り替え（ライト既定・ダークは右上の月のボタン）

要点は 3 つ。

1. 色は `:root` と `:root[data-theme='dark']` の**トークンだけ**で切り替える（部品側は何もしない）
2. **描画より前に** `html[data-theme]` を付ける。React の描画後に付けるとダークの人の画面が一瞬白く光る
3. ブラウザのバーの色（`<meta name="theme-color">`）も `--bg` と同じ値に揃える

```ts
// theme.ts — 画面の配色（ライト／ダーク）。既定はライト。ブラウザに記憶する
export type Theme = 'light' | 'dark';

const KEY = 'app.theme';
/** アドレスバー・ステータスバーの色。CSS の --bg と揃える */
const BAR_COLOR: Record<Theme, string> = {light: '#eef0f4', dark: '#0f1114'};

export const readTheme = (): Theme => {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light'; // localStorage が使えない環境でも落ちない
  }
};

export const applyTheme = (t: Theme) => {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR_COLOR[t]);
};

export const saveTheme = (t: Theme) => {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* 記憶できなくても動作には影響しない */
  }
  applyTheme(t);
};
```

```ts
// main.tsx — createRoot より前に呼ぶ
import './styles.css';
import {applyTheme, readTheme} from './theme';
applyTheme(readTheme());
```

```html
<!-- index.html の head -->
<meta name="theme-color" content="#eef0f4" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

ボタンは `.icon-btn` で、ライトのとき `☾`（暗くする）、ダークのとき `☀`（明るくする）を出す。`aria-label="配色を切り替える"`。

> Next.js（SSR）では `main.tsx` の代わりに、`<head>` に `readTheme` → `applyTheme` 相当の**インラインスクリプト**を置く
> （`<html suppressHydrationWarning>` を付ける）。そうしないと同じく一瞬白く光る。

---

## 7. スマホ・タッチ（〜860px）

同じトンマナのまま「置き場所」と「指で押せる大きさ」だけ変える。

```css
.bottomnav { display: none; }   /* 広い画面では出さない（@media より前に置く） */

@media (max-width: 860px) {
  :root { font-size: 14px; }
  /* 16px 未満の入力欄は iOS がタップのたびに画面を拡大する */
  input, select, textarea { font-size: 16px; }
  button { min-height: 40px; }
  button.small { min-height: 32px; }

  .app { padding-bottom: calc(58px + env(safe-area-inset-bottom)); } /* 下部ナビのぶん */
  .topbar {
    background: var(--bg);
    flex-wrap: wrap; gap: 8px; padding: 6px 10px;
    padding-top: max(6px, env(safe-area-inset-top));
  }
  .topbar .tabs, .topbar .help-btn { display: none; }      /* タブは下部ナビへ移す */
  .topbar .theme-btn { order: 1; margin-left: auto; }       /* 配色ボタンはロゴの行の右端 */
  .status { order: 2; width: 100%; flex-wrap: wrap; gap: 6px; }
  .status select { flex: 1 1 160px; min-width: 0; }

  .main { padding: 8px; }
  .card { padding: 10px; }
  /* 横並びの入力は縦に積む */
  .row > label, .row > input:not([type='checkbox']):not([type='radio']), .row > select, .row > textarea {
    flex: 1 1 100%; min-width: 0;
  }
  .toasts { right: 8px; left: 8px; bottom: calc(66px + env(safe-area-inset-bottom)); }

  /* 下部ナビ：白い帯、選択中は青い文字＋淡い青の角丸 */
  .bottomnav {
    display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;
    background: var(--panel); border-top: 1px solid var(--line);
    box-shadow: 0 -4px 16px rgba(15, 20, 30, 0.06);
    gap: 4px; padding: 0 6px env(safe-area-inset-bottom);
  }
  .bottomnav .bn {
    flex: 1 1 0; min-width: 0; min-height: 54px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    background: transparent; border: none; box-shadow: none; border-radius: 12px;
    color: var(--muted); padding: 4px 2px;
  }
  .bottomnav .bn.active { color: var(--accent); background: var(--accent-soft); }
  .bn-icon { font-size: 17px; line-height: 1; }
  .bn-label { font-size: 10px; white-space: nowrap; }

  /* キャンバスの設定ピルは作品に被らないよう下へ */
  .canvas { padding: 12px; }
  .canvas-pill { position: static; margin-top: 10px; justify-content: center; }
}

/* 指の操作のときだけ掴む場所を大きく（マウスの見た目は変えない） */
@media (pointer: coarse) {
  /* 例：トリムの端 10〜14px → 20〜22px、細い段は 24px 以上に */
}
```

狭い画面の詳細パネルは「下からせり上がるシート」にする。シートの閉じる帯は `@media (min-width: 861px) { … display: none }` で**広い画面の側を囲って消す**（素の規則で消すと、後から足した規則が @media より後ろに来てスマホでも消える）。

---

## 8. 守る規則（チェックリスト）

- [ ] 色は §3 のトークンだけ。新しい色が要るときはトークンを足し、ライト・ダーク両方に値を入れる
- [ ] 状態は「淡い下地 `--tint-*` ＋ 文字 `--tint-*-fg`」のチップ。塗りつぶし（白文字）は見落とすと困る警告だけ
- [ ] 中身は白い `.card`（角丸 16px・1px 線・`--shadow-sm`）に載せる。見出しは小さな大文字ラベル
- [ ] 選択・フォーカスは **青い枠＋3px の淡い青のリング**（`0 0 0 3px var(--accent-soft)`）で統一
- [ ] 浮いた部品の影は 3 段だけ（常時 `--shadow-sm` / ホバー・浮遊 `--shadow-md` / ポップアップ `0 14px 40px var(--shadow-lg-c)`）
- [ ] オレンジはブランド印と AI ボタンだけ。他の操作に使わない
- [ ] トランジションは 0.12s。常時動くアニメは `prefers-reduced-motion: reduce` で止める
- [ ] 横並びの子には `min-width: 0`。`select` には `contain: layout`（iPhone で横スクロールが出るのを防ぐ）
- [ ] スマホでは入力欄 16px・ボタン最低 40px・下部ナビ 54px、`env(safe-area-inset-*)` で余白を取る
- [ ] テーマは描画前に `html[data-theme]` を付け、`theme-color` を `--bg` に合わせる
- [ ] スマホだけのはみ出しは Chrome では再現しないことがある。Playwright の WebKit（iPhone 相当）で確かめる

## 9. 参照元

| 内容 | ファイル |
|---|---|
| トークン・全部品 | `src/styles.css`（冒頭 1–100 行がトークン） |
| テーマの適用と記憶 | `src/theme.ts`、`src/main.tsx`、`src/App.tsx`（`toggleTheme`） |
| 上部バーの構造 | `src/App.tsx`（`.topbar`） |
| 再生操作とアイコン | `src/editor/Transport.tsx` |
| タイムラインの段 | `src/editor/Timeline.tsx` |
| 「Claude に頼む」 | `src/editor/AiMenu.tsx` |
