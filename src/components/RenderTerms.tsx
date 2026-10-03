// Render の「レンダー（手動）」に出てくる用語の説明。見出しの「用語の説明」ボタンで開く。
// 中身は core/render.ts（draft/render/still）・core/thumbnails.ts（QC タイル）・server/jobs.ts（保守ボタン）の実際の動きに合わせてある
import React from 'react';

type Term = {t: string; d: React.ReactNode};

const BASIC: Term[] = [
  {t: 'ドラフト', d: '画面を 1/4 の大きさ・粗い画質で速く書き出す確認用の動画（out/draft.mp4）。並びやテロップを通しで見るためのもので、納品には使いません'},
  {t: '本番レンダー', d: '実寸・高画質で書き出す完成用の動画（out/final.mp4）。サムネイルと QC タイルも一緒に作られます'},
  {t: 'カット', d: '動画を区切った 1 つ 1 つの場面の番号です。Timeline の並びの上から 1, 2, 3…と数えます。「スチル」でどの場面を撮るかを指定します'},
  {t: 'オフセット秒', d: '選んだカットの頭から何秒進んだところを撮るか。テロップは出始めに約 0.13 秒かけてふわっと出るので、0.3 秒ほど進めると文字がはっきり写ります（空欄・0 だとカットの最初の 1 コマ）。カットの長さを超えた値はカットの最後の 1 コマになります'},
  {t: 'スチル', d: '動画を書き出さずに、指定したカットの 1 コマだけを静止画（qc/cut01.png など）にします。テロップの位置・文字の切れ・色を数秒で確かめたいときに使います'},
  {t: 'QC 対象', d: '「QC タイル」を作る元の動画を選びます。final.mp4 は本番レンダー、draft.mp4 はドラフト、final_narration.mp4 はナレーションを混ぜた完成品です。先にその動画を書き出しておく必要があります'},
  {t: 'QC タイル', d: 'QC は品質チェック（Quality Check）のこと。動画から 3 秒ごとに 1 コマずつ、最大 12 コマを 4×3 に並べた一覧画像（qc/final-tile.png など）を作ります。再生しなくても全体の流れ・黒い画面・似た画の連続をひと目で確認できます'},
];

const OPTIONS: Term[] = [
  {t: 'gl', d: '映像を描く方式。既定の swiftshader はグラフィックボードを使わない一番安定する方式です。angle / vulkan / egl などはグラボを使うので速くなることがありますが、PC によっては真っ黒・失敗になります。困ったときは swiftshader に戻してください'},
  {t: 'concurrency', d: '何コマを同時に描くか（並列数）。空欄（auto）なら PC に合わせて自動。大きいと速いがメモリを多く使い、小さいと遅いが落ちにくくなります。途中で止まる・PC が重くなるときは 1 や 2 にします'},
  {t: 'crf', d: '画質の数値。小さいほど高画質・ファイルが大きく、大きいほど粗く小さくなります。空欄なら本番は 20、ドラフトは 30。普段は変えなくて大丈夫です（18〜23 くらいが目安）'},
  {t: 'cache MB', d: '素材動画を読み込むときに一時的に使うメモリの量（MB）。空欄なら 256。メモリ不足で落ちるときは 128 などに下げます'},
  {t: 'retries', d: '失敗したときに自動でやり直す回数（最初の 1 回を含む）。2 回目以降は自動で concurrency=1・cache 128MB に落とし、3 回目は速い圧縮に切り替えて通しにいきます'},
  {t: 'force（W を無視）', d: '検証の「W（注意）」があっても進める指定です。いまは W ではもともとレンダーが止まらないので、普段はチェック不要です。「E（エラー）」で止まったときは、上に出る「指摘を承知で…」のボタンを使います'},
  {t: 'no-sync', d: 'レンダーの前に、案件の中の描画プログラム（エンジン）を Reel Studio 本体の最新版に揃える処理をしない指定。案件のエンジンを手で直していて、上書きされたくないときだけ使います'},
  {t: 'strict-proxy', d: 'HEVC（iPhone の高効率形式）や 4K の素材が入っているとき、通常は「W：プロキシ推奨」の注意で済ませますが、これを入れるとエラー扱いにしてレンダーを止めます。重い素材が残っていないか厳しく確かめたいとき用です'},
];

const MAINT: Term[] = [
  {t: 'alias 適用', d: '同じ素材を離れた場所で 2 回以上使うと Windows で書き出しが不安定になるため、中身が同じ別名のコピー（alias）を作って振り替えます。上に「ファイル名を最適化」が出ていればそちらで足ります'},
  {t: 'HEVC/4K プロキシ', d: 'HEVC や 4K の重い素材を、扱いやすい H.264・縦 1080×1920 に変換して置き換えます（プロキシ＝代わりの軽い版）。書き出しが遅い・失敗するときに試します。顔モザイク済みの素材は飛ばします'},
  {t: 'エンジン同期', d: '案件の中の描画プログラム（エンジン）を Reel Studio 本体の最新版に揃えます。通常はレンダー時に自動で行われます'},
  {t: 'npm install', d: '案件で動画を描くのに必要な部品（Remotion など）を入れ直します。「remotion が見つからない」といったエラーが出たときに押します。数分かかります'},
];

const Group: React.FC<{title: string; terms: Term[]}> = ({title, terms}) => (
  <>
    <h3>{title}</h3>
    <dl className="help-terms">
      {terms.map((x) => (
        <React.Fragment key={x.t}>
          <dt>{x.t}</dt>
          <dd>{x.d}</dd>
        </React.Fragment>
      ))}
    </dl>
  </>
);

/** 見出しの右に置く開閉ボタン */
export const RenderTermsToggle: React.FC<{open: boolean; onToggle: () => void}> = ({open, onToggle}) => (
  <button className="small help-toggle" onClick={onToggle} aria-expanded={open}>
    {open ? '説明を閉じる' : '？ 用語の説明'}
  </button>
);

export const RenderTerms: React.FC<{onClose: () => void}> = ({onClose}) => (
  <div className="render-terms">
    <Group title="ボタンと入力欄" terms={BASIC} />
    <Group title="オプション（細かい書き出し設定。普段は触らなくて大丈夫）" terms={OPTIONS} />
    <Group title="保守（うまくいかないときの手当て）" terms={MAINT} />
    <div className="row" style={{marginTop: 8}}>
      <button className="small" onClick={onClose}>
        閉じる
      </button>
    </div>
  </div>
);

/** 各入力欄にマウスを乗せたときの短い説明（title 属性用） */
export const termHint = (t: string): string | undefined => {
  const x = [...BASIC, ...OPTIONS, ...MAINT].find((y) => y.t === t);
  return typeof x?.d === 'string' ? x.d : undefined;
};
