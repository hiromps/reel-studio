// ガイドツアー：画面の要素をスポットライトで順に指しながら説明する。初回起動時に自動で開き、
// 以降は「? 使い方」からいつでも呼び直せる。対象が無いステップ（案件未オープン等）は自動で飛ばす。
import React, {useCallback, useEffect, useRef, useState} from 'react';

export type TourTab = 'projects' | 'materials' | 'brief' | 'timeline' | 'render';

export type TourStep = {
  id: string;
  /** 見せる前にこのタブへ移動する */
  tab?: TourTab;
  /** 対象要素の data-tour 値。省略すると画面中央に出す */
  target?: string;
  title: string;
  body: React.ReactNode;
};

const CARD_W = 380;
const NEED = 250; // カードを置くのに欲しい高さ

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Reel Studio へようこそ',
    body: (
      <>
        <p>素材の動画を渡すと、テロップ付きの縦型ショート動画（9:16）に仕上げるツールです。</p>
        <p className="tour-flow">
          <b>Projects</b> 案件を作る → <b>Materials</b> 素材を読み込む → <b>Brief</b> 何を伝えるか決める → <b>Timeline</b> カット順とテロップ → <b>Render</b> 書き出し
        </p>
        <p className="hint">左上の数字が進み具合です。いつでも Esc で閉じられます（← → キーでも進めます）。</p>
      </>
    ),
  },
  {
    id: 'tabs',
    target: 'tabs',
    title: 'タブは作業の順番',
    body: <p>左から右へ進むだけで 1 本できます。途中で前に戻っても大丈夫です。迷ったら左から順に見てください。</p>,
  },
  {
    id: 'nextbar',
    target: 'next',
    title: '「次にやること」を見れば迷わない',
    body: (
      <>
        <p>いまの案件の状態から、次にやるべきことを 1 行で出します。右のボタンを押すとその画面へ飛びます。</p>
        <p className="hint">不要になったら × で消せます（「? 使い方」から戻せます）。</p>
      </>
    ),
  },
  {
    id: 'project-select',
    target: 'project-select',
    title: '扱っている案件はここ',
    body: <p>いま開いている案件（動画 1 本 ＝ 1 案件）です。切り替えると全タブの中身が入れ替わります。未保存の変更があるときは右に「未保存」と出ます。</p>,
  },
  {
    id: 'new-project',
    tab: 'projects',
    target: 'new-project',
    title: '① 案件を作る',
    body: (
      <>
        <p>
          <b>slug</b> は案件のフォルダ名（例 <code>reunion-hiro</code>）。<b>persona</b> は誰の声・文体で作るか（hiro / 凪 / さゆり / ぼんじり）です。
        </p>
        <p className="hint">作成すると work/&lt;slug&gt;-reel/ にテンプレ一式がコピーされます。</p>
      </>
    ),
  },
  {
    id: 'materials-folder',
    tab: 'materials',
    target: 'materials-folder',
    title: '② 素材フォルダを読み込む',
    body: (
      <>
        <p>撮った動画が入ったフォルダを選んで「カタログ実行」。長さ・解像度を調べ、案件フォルダにコピーし、サムネイルを作ります。</p>
        <p className="hint">4K や HEVC は自動で軽い H.264 に変換（プロキシ）します。ここが一番時間のかかる工程です。</p>
      </>
    ),
  },
  {
    id: 'clip-grid',
    tab: 'materials',
    target: 'clip-grid',
    title: '③ 素材にタグを付ける',
    body: (
      <>
        <p>1 本ずつ「これは何が映っているか」（外観 / 看板 / 実食 / シズル …）を記録します。この情報で構成が自動で組まれます。</p>
        <p>
          クリックして右側で編集できますが、<b>Claude に頼むのが速い</b>です。「未タグ」の表示の横に頼み方が出ます。
        </p>
        <p className="hint">★フック＝つかみに使いたい画。NG＝使わない画。ここは自分で決めてください。</p>
      </>
    ),
  },
  {
    id: 'materials-timeline',
    tab: 'materials',
    target: 'materials-timeline',
    title: '③′ 自分で並べるならタイムラインへ',
    body: (
      <>
        <p>
          並び順が頭の中で決まっているなら、素材カードを<b>ここへドラッグ</b>して並べ、<b>ブロックの両端</b>を引いて尺を決めます。中を掴むと順番を入れ替えられます。
        </p>
        <p className="hint">これで cuts.json ができるので、Brief の自動生成は飛ばして Timeline でテロップを付けられます。型どおりの役割を付けたければ「この並びを brief の固定順にする」。</p>
      </>
    ),
  },
  {
    id: 'brief-form',
    tab: 'brief',
    target: 'brief-form',
    title: '④ 何を伝えるかを決める',
    body: (
      <>
        <p>店名・エリア・企画の核（何が驚きか）・冒頭フックに使う画などを入れます。ここが動画の設計図です。</p>
        <p className="hint">format（F0〜F7）は構成の型。迷ったら persona の既定のままで大丈夫です。</p>
      </>
    ),
  },
  {
    id: 'brief-plan',
    tab: 'brief',
    target: 'brief-plan',
    title: '⑤ カット構成を自動で組む',
    body: (
      <>
        <p>「プラン生成」で構成案を確認 →「cuts.json に書き込む」で確定します。どのカットを何秒使うかが決まります。</p>
        <p className="hint">テロップの文言はまだ空（{'{{g01:hook}}'} のような仮）です。次の Timeline で埋めます。</p>
      </>
    ),
  },
  {
    id: 'storyboard',
    tab: 'timeline',
    target: 'storyboard',
    title: '⑥ 絵コンテでカットの順番を決める',
    body: (
      <>
        <p>
          <b>サムネをドラッグすると順番が入れ替わります。</b>黄色い縦線が落ちる位置です。クリックするとその場面にジャンプします。
        </p>
        <p className="hint">間違えても「↶ 元に戻す」か Ctrl+Z で戻せます。</p>
      </>
    ),
  },
  {
    id: 'sb-card',
    tab: 'timeline',
    target: 'sb-card-0',
    title: 'カードの読み方',
    body: (
      <>
        <ul className="tour-list">
          <li>
            左上の数字 ＝ <b>何番目のカット</b>／右下 ＝ そのカットの<b>長さ</b>
          </li>
          <li>
            上の色帯と <code>gNN</code> ＝ <b>同じテロップが続く範囲</b>。既定ではこの単位でまとめて動きます
          </li>
          <li>
            <code>!</code> ＝ エラー、<code>?</code> ＝ 警告。下の検証欄に理由が出ます
          </li>
          <li>下段の文字 ＝ そのカットに出るテロップ</li>
        </ul>
      </>
    ),
  },
  {
    id: 'cut-rows',
    tab: 'timeline',
    target: 'cut-rows',
    title: '⑦ テロップと長さを詰める',
    body: (
      <>
        <p>各カットの素材・IN/OUT（使う区間）・テロップ文をここで直します。⠿ を掴めばこちらでも並べ替えられます。</p>
        <p className="hint">テロップは 13 文字が目安。超えると赤くなります。左のプレビューは編集しながら即座に反映されます。</p>
      </>
    ),
  },
  {
    id: 'validation',
    tab: 'timeline',
    target: 'validation',
    title: '⑧ 検証（E をゼロにする）',
    body: (
      <>
        <p>
          <b>E（エラー）</b>が残っていると書き出せません。<b>W（警告）</b>は直した方がよい指摘です。行をクリックするとその場面へ飛び、「適用」で自動修正できるものもあります。
        </p>
      </>
    ),
  },
  {
    id: 'save',
    tab: 'timeline',
    target: 'save',
    title: '保存を忘れずに',
    body: (
      <p>
        編集は <b>Ctrl+S</b> で保存します。保存するまでファイルには書かれません（レンダーもできません）。
      </p>
    ),
  },
  {
    id: 'render',
    tab: 'render',
    target: 'render-run',
    title: '⑨ 書き出す',
    body: (
      <>
        <p>
          まず<b>ドラフト</b>（粗い・速い）で全体を確認 → 問題なければ<b>本番レンダー</b>。進み具合と結果は下に出ます。
        </p>
        <p className="hint">ナレーションを付ける場合は、本番レンダーのあとに「ナレーション合成（mix）」を実行します。</p>
      </>
    ),
  },
  {
    id: 'done',
    title: 'ここまでです',
    body: (
      <>
        <p>右上の「? 使い方」からこの案内・ショートカット一覧・用語集をいつでも開けます。</p>
        <p className="hint">困ったら「次にやること」の 1 行に従えば進めます。</p>
      </>
    ),
  },
];

type Props = {
  open: boolean;
  tab: TourTab;
  onTab: (t: TourTab) => void;
  onClose: () => void;
};

type Rect = {left: number; top: number; width: number; height: number};

export const Tour: React.FC<Props> = ({open, tab, onTab, onClose}) => {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const dir = useRef<1 | -1>(1);
  const startTab = useRef<TourTab>(tab);
  const step = TOUR_STEPS[i];

  // 開いたときだけ最初に戻す。閉じるときに元いたタブへ帰る
  useEffect(() => {
    if (open) {
      setI(0);
      dir.current = 1;
      startTab.current = tab;
    }
    // tab は開いた瞬間の値だけ使いたいので依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = useCallback(() => {
    onTab(startTab.current);
    onClose();
  }, [onClose, onTab]);

  const go = useCallback((d: 1 | -1) => {
    dir.current = d;
    setI((n) => {
      const next = n + d;
      if (next < 0) return 0;
      return next;
    });
  }, []);

  // 必要ならタブを移動
  useEffect(() => {
    if (!open || !step) return;
    if (step.tab && step.tab !== tab) onTab(step.tab);
  }, [open, step, tab, onTab]);

  // 対象を測る。見つからなければ同じ向きへ 1 つ飛ばす
  useEffect(() => {
    if (!open || !step) return;
    let alive = true;
    let tries = 0;
    const measure = () => {
      if (!alive) return;
      if (!step.target) {
        setRect(null);
        return;
      }
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (el) {
        el.scrollIntoView({block: 'center', inline: 'nearest'});
        const r = el.getBoundingClientRect();
        setRect({left: r.left, top: r.top, width: r.width, height: r.height});
        return;
      }
      if (++tries < 8) return void setTimeout(measure, 60);
      // 出てこない＝この案件ではまだ存在しない要素。飛ばす
      if (i + dir.current >= TOUR_STEPS.length) return close();
      if (i + dir.current < 0) return setI(0);
      setI(i + dir.current);
    };
    measure();
    return () => {
      alive = false;
    };
  }, [open, step, i, close]);

  // 追従（スクロール・リサイズ）
  useEffect(() => {
    if (!open || !step?.target) return;
    const sync = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({left: r.left, top: r.top, width: r.width, height: r.height});
    };
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
    };
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close();
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        if (i >= TOUR_STEPS.length - 1) return close();
        go(1);
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, i, go, close]);

  if (!open || !step) return null;

  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const pad = 6;
  const hole = rect ? {left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2} : null;
  const cardPos: React.CSSProperties = !hole
    ? {left: Math.max(12, vw / 2 - CARD_W / 2), top: Math.max(12, vh / 2 - 160)}
    : vh - (hole.top + hole.height) > NEED
      ? {left: Math.min(Math.max(12, hole.left), vw - CARD_W - 12), top: hole.top + hole.height + 12}
      : hole.top > NEED
        ? {left: Math.min(Math.max(12, hole.left), vw - CARD_W - 12), bottom: vh - hole.top + 12}
        : {left: Math.min(Math.max(12, hole.left + hole.width + 12), vw - CARD_W - 12), top: 60};

  const last = i >= TOUR_STEPS.length - 1;
  return (
    <div className="tour-root">
      <div className="tour-block" onClick={(e) => e.stopPropagation()} />
      {hole ? <div className="tour-hole" style={hole} /> : <div className="tour-dim" />}
      <div className="tour-card" style={{width: CARD_W, ...cardPos}}>
        <div className="tour-head">
          <span className="tour-step">
            {i + 1} / {TOUR_STEPS.length}
          </span>
          <b>{step.title}</b>
          <button className="small tour-x" onClick={close} title="閉じる（Esc）">
            ×
          </button>
        </div>
        <div className="tour-body">{step.body}</div>
        <div className="tour-foot">
          <button className="small" onClick={close}>
            閉じる
          </button>
          <span style={{flex: 1}} />
          <button className="small" onClick={() => go(-1)} disabled={i === 0}>
            ← 戻る
          </button>
          <button className="small primary" onClick={() => (last ? close() : go(1))}>
            {last ? '終わる' : '次へ →'}
          </button>
        </div>
      </div>
    </div>
  );
};
