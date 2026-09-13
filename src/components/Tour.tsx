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
        <p>素材の動画を渡すと、テロップとナレーション付きの縦型ショート動画（9:16）に仕上げるツールです。</p>
        <p className="tour-flow">
          <b>Projects</b> 案件を作る → <b>Materials</b> 素材を読み込む → <b>Brief</b> 何を伝えるか決める（台本でも可） → <b>Timeline</b> 並び・テロップ・ナレーションを編集 → <b>Render</b>「仕上げ」で完成
        </p>
        <p className="hint">左上の数字が進み具合です。いつでも Esc で閉じられます（← → キーでも進めます）。</p>
      </>
    ),
  },
  {
    id: 'tabs',
    target: 'tabs',
    title: 'タブは作業の順番',
    body: <p>左から右へ進むだけで 1 本できます。Ctrl+1〜5 でも切り替えられます。途中で前に戻っても大丈夫です。</p>,
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
          <b>slug</b> は案件のフォルダ名（例 <code>reunion-hiro</code>）。<b>persona</b> は誰の声・文体で作るか（hiro / 凪 / ぼんじり）です。
        </p>
        <p className="hint">作成すると work/&lt;slug&gt;-reel/ にテンプレ一式がコピーされます。同じ素材で別バージョンを作るなら「同じ素材から作る」。</p>
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
        <p>1 本ずつ「これは何が映っているか」（外観 / 看板 / 実食 / シズル …）を記録します。この情報で構成が自動で組まれ、台本からの組み立てにも使われます。</p>
        <p>
          クリックして右側で編集できますが、<b>Claude に頼むのが速い</b>です。「AI にタグ付けしてもらう」を押すだけ。
        </p>
        <p className="hint">★フック＝つかみに使いたい画。NG＝使わない画。ここは自分で決めてください。</p>
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
    id: 'script',
    tab: 'brief',
    target: 'script',
    title: '④′ 台本があるなら貼るだけ',
    body: (
      <>
        <p>
          人が書いた台本（【0〜3秒】フック／映像：／テロップ：／ナレーション：）を貼って「台本から組み立てる」を押すと、素材のタグと突き合わせて <b>カット構成とナレーション原稿</b> まで一度に作ります。
        </p>
        <p className="hint">型に収まらない長尺もこちらで作れます。「プラン生成」（型に流し込む）とはどちらか一方を使います。</p>
      </>
    ),
  },
  {
    id: 'brief-plan',
    tab: 'brief',
    target: 'brief-plan',
    title: '⑤ 台本が無ければ型で組む',
    body: (
      <>
        <p>「プラン生成」で構成案を確認 →「cuts.json に書き込む」で確定します。どのカットを何秒使うかが決まります。</p>
        <p className="hint">テロップの文言はまだ空（{'{{g01:hook}}'} のような仮）です。次の Timeline で埋めます。</p>
      </>
    ),
  },
  {
    id: 'editor-layout',
    tab: 'timeline',
    target: 'timeline',
    title: '⑥ タイムラインで全部を整える',
    body: (
      <>
        <p>
          4 段のタイムラインです。<b>V</b> 映像（両端で尺、中を掴んで並べ替え）／<b>T</b> テロップ（同じ文言が続く範囲）／<b>N</b> ナレーション（横にドラッグで配置秒）／<b>S</b> 効果音。
        </p>
        <p className="hint">目盛りをクリックで再生ヘッド。Ctrl+ホイールで拡大。Space で再生、← → で 1 コマ。</p>
      </>
    ),
  },
  {
    id: 'bin',
    tab: 'timeline',
    target: 'bin',
    title: '素材ビン',
    body: (
      <>
        <p>
          左は素材の一覧です。カードを <b>V 段へドラッグ</b>（またはダブルクリック／＋）で追加できます。未使用の本数が出るので、使い残しが分かります。
        </p>
        <p className="hint">タグや使える区間の編集は Materials 画面で。</p>
      </>
    ),
  },
  {
    id: 'inspector',
    tab: 'timeline',
    target: 'inspector',
    title: 'インスペクタ',
    body: (
      <>
        <p>
          タイムラインで選んだものの編集欄です。カットなら素材・IN/OUT・テロップ文・バッジ、テロップ段のブロックならグループ全体の文言、ナレーションなら本文と配置秒と試聴。
        </p>
        <p className="hint">何も選んでいないときは動画全体（テーマ・バッジの濃さ）とショートカット一覧が出ます。</p>
      </>
    ),
  },
  {
    id: 'ai-menu',
    tab: 'timeline',
    target: 'ai-menu',
    title: 'AI に任せる',
    body: (
      <>
        <p>
          「AI ▾」から、テロップの文言・ナレーション原稿・並べ替え・自由な直し（「3 カット目を短く」など）を裏で Claude に代行させられます。
        </p>
        <p className="hint">API 課金が発生します。AI の文言は下書き扱いなので必ず読み直してください。</p>
      </>
    ),
  },
  {
    id: 'validation',
    tab: 'timeline',
    target: 'validation',
    title: '⑦ 検証（E をゼロにする）',
    body: (
      <>
        <p>
          <b>E（エラー）</b>が残っていると書き出せません。<b>W（警告）</b>は直した方がよい指摘です。行をクリックするとその場面へ飛び、「適用」で自動修正できるものもあります。ナレーションの重なりや効果音の団子もここに出ます。
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
        編集は <b>Ctrl+S</b> で保存します（cuts.json と narration.json）。保存するまでファイルには書かれません（AI にも渡りません）。
      </p>
    ),
  },
  {
    id: 'build',
    tab: 'render',
    target: 'build',
    title: '⑧ 「仕上げ」で完成まで一気に',
    body: (
      <>
        <p>
          案件の状態を見て、残っている工程（原稿 → 音声 → レンダー → 合成 → 納品）だけをチェック済みにしてあります。<b>「仕上げを実行」</b>で順に走り、outputs/ に「店名_人格_ナレーション付き.mp4」が出ます。
        </p>
        <p className="hint">途中で失敗したらそこで止まります。直してからもう一度押せば、済んだ工程は飛ばします。</p>
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
