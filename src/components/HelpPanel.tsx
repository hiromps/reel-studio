// 「? 使い方」パネル。全体の流れ・絵コンテの読み方・ショートカット・用語をまとめて置く。
// 初めての人が「この画面は何をするところか」を後から確認できる場所。
import React, {useEffect, useState} from 'react';
import type {TourTab} from './Tour';

const FLOW: {tab: TourTab; label: string; what: string}[] = [
  {tab: 'projects', label: '① Projects', what: '案件（動画 1 本）を作る・開く'},
  {tab: 'materials', label: '② Materials', what: '素材フォルダを読み込み、1 本ずつタグを付ける。並びを自分で決めるならタイムラインに落として尺を決める'},
  {tab: 'brief', label: '③ Brief', what: '何を伝えるかを決めて、カット構成を自動生成する（Materials で並べた場合は省略できる）'},
  {tab: 'timeline', label: '④ Timeline', what: 'カットの順番・長さ・テロップを整えて検証する'},
  {tab: 'render', label: '⑤ Render', what: 'ドラフトで確認して本番レンダー、必要ならナレーション合成'},
];

const KEYS: {k: string; what: string; where: string}[] = [
  {k: 'Ctrl + S', what: '編集中のファイルを保存', where: 'Timeline／Materials'},
  {k: 'Ctrl + Z', what: 'カットの並び・追加・複製・削除を戻す', where: 'Timeline／Materials'},
  {k: 'ドラッグ', what: '素材カードをタイムラインに落として追加（青い縦線の位置に入る）', where: 'Materials の素材カード'},
  {k: 'ドラッグ', what: 'ブロックの両端で尺（IN/OUT）、中を掴んで並べ替え、Alt+ドラッグで中身をずらす', where: 'Materials のタイムライン'},
  {k: 'Delete / S', what: '選択中のカットを外す／再生ヘッドの位置で分割', where: 'Materials のタイムライン'},
  {k: 'Ctrl + ホイール', what: '拡大・縮小（ポインタの下の時刻を動かさない）', where: 'Materials のタイムライン'},
  {k: 'ドラッグ', what: 'カットの順番を入れ替える', where: '絵コンテ／カット行の ⠿'},
  {k: 'ドラッグ', what: '尺を決める（両端で IN/OUT、中を掴むと窓ごと移動）', where: 'カット行のフィルム帯'},
  {k: '← →（つまみ選択中）', what: '1 フレームずつ／Shift で 10 フレーム', where: 'カット行のフィルム帯'},
  {k: 'Alt + ← →', what: '選択中のカードを 1 つ前後へ動かす', where: '絵コンテ'},
  {k: '← →', what: '選択するカードを移動', where: '絵コンテ'},
  {k: 'Esc', what: 'ドラッグを取り消す／ツアーを閉じる', where: '全体'},
  {k: '?', what: 'このパネルを開く', where: '全体'},
];

const TERMS: {t: string; d: string}[] = [
  {t: 'カット', d: '1 つの素材から切り出した 1 区間。これを並べたものが動画になる'},
  {t: 'フック', d: '冒頭の掴み。ここで見るのをやめられるかが決まるので一番大事な 1〜2 カット'},
  {t: 'リビール', d: '店名や正体を明かす場面。発見型（F7）では終盤まで隠す'},
  {t: 'テロップグループ', d: '同じ文言が続くカットのまとまり。絵コンテの色帯と gNN。1 カット 1 文言だと速すぎて読めないため、複数カットにまたがらせる'},
  {t: 'slot / role', d: '各カットの役割（フック・証拠・シズル・情報・CTA…）。構成の型から自動で割り当てられる'},
  {t: 'プロキシ', d: '4K や HEVC の重い素材から作る軽い H.264 版。プレビューとレンダーを安定させる'},
  {t: 'alias', d: '同じ素材を離れた位置で 2 回使うときの別名コピー。Remotion が不安定になるのを避けるため'},
  {t: 'E / W', d: 'E＝エラー（直さないと書き出せない）、W＝警告（直した方がよい）'},
  {t: 'ドラフト', d: '0.25 倍の粗いレンダー。全体の流れを速く確認するためのもの'},
];

type Props = {
  open: boolean;
  onClose: () => void;
  onTab: (t: TourTab) => void;
  onStartTour: () => void;
  nextBarHidden: boolean;
  onNextBar: (show: boolean) => void;
};

export const HelpPanel: React.FC<Props> = ({open, onClose, onTab, onStartTour, nextBarHidden, onNextBar}) => {
  const [sec, setSec] = useState<'flow' | 'storyboard' | 'keys' | 'terms'>('flow');

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;
  const go = (t: TourTab) => {
    onTab(t);
    onClose();
  };

  return (
    <div className="modal-root" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>使い方</b>
          <span style={{flex: 1}} />
          <button className="small primary" onClick={onStartTour}>
            ガイドツアーを見る
          </button>
          <button className="small" onClick={onClose}>
            閉じる（Esc）
          </button>
        </div>
        <div className="modal-tabs">
          {(
            [
              ['flow', '全体の流れ'],
              ['storyboard', '絵コンテの見方'],
              ['keys', 'ショートカット'],
              ['terms', '用語'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={`chip${sec === id ? ' on' : ''}`} onClick={() => setSec(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {sec === 'flow' && (
            <>
              <p className="hint">左のタブから順に進めば 1 本できます。行き先に迷ったら、画面上の「次にやること」に従ってください。</p>
              <ol className="help-flow">
                {FLOW.map((f) => (
                  <li key={f.tab}>
                    <button className="small" onClick={() => go(f.tab)}>
                      {f.label}
                    </button>
                    <span>{f.what}</span>
                  </li>
                ))}
              </ol>
              <h3>Claude に任せられるところ</h3>
              <ul className="tour-list">
                <li>素材のタグ付け（Materials の「AI にタグ付けしてもらう」。裏で Claude が起動してサムネイルを 1 枚ずつ見ます）</li>
                <li>カットの並び順（Timeline の「AI に並べ替えてもらう」。型に沿った順に組み直します）</li>
                <li>テロップの文言（Timeline の「AI にテロップを書いてもらう」。カット頭の画を見て {'{{gNN:intent}}'} を埋めます。書いたものは下書き扱いなので必ず読み直してください）</li>
                <li>細かい直し（Timeline の「AI に直してもらう」。直したいことを書いて送ると、テロップ・ナレーションのセリフ・カットの区間や並びを直します）</li>
                <li className="hint">いずれも API 課金が発生します。モデルは横のプルダウンで選べます（opus が既定）</li>
                <li>ナレーション原稿と音声の生成・合成</li>
              </ul>
              <h3>表示の設定</h3>
              <label className="sb-inline">
                <input type="checkbox" checked={!nextBarHidden} onChange={(e) => onNextBar(e.target.checked)} />
                <span>画面上に「次にやること」を表示する</span>
              </label>
            </>
          )}

          {sec === 'storyboard' && (
            <>
              <p>Timeline の一番上にある、カットをサムネで並べた帯です。ここで動画の流れを作ります。</p>
              <h3>操作</h3>
              <ul className="tour-list">
                <li>
                  <b>サムネをドラッグ</b>：順番を入れ替える（黄色い縦線が落ちる位置）
                </li>
                <li>
                  <b>クリック</b>：その場面へジャンプ（下のカット行もそこまでスクロール）
                </li>
                <li>
                  <b>Alt + ← →</b>：1 つずつ動かす／<b>Esc</b>：ドラッグ取り消し
                </li>
                <li>
                  <b>↶ 元に戻す・Ctrl+Z</b>：並び・追加・複製・削除を 30 手まで戻す
                </li>
              </ul>
              <h3>カードの見方</h3>
              <ul className="tour-list">
                <li>左上の数字＝何番目のカット／右下＝そのカットの長さ（秒）</li>
                <li>上の色帯と gNN ＝ 同じテロップが続く範囲。「テロップ単位で動かす」が ON なら、この範囲がまとめて動きます</li>
                <li>
                  <code>!</code>＝エラー、<code>?</code>＝警告、🔒＝再生成しても動かさない固定、<code>1.5x</code>＝倍速
                </li>
                <li>左下の小さい文字＝そのカットの役割（フック・証拠・リビールなど）</li>
              </ul>
              <p className="hint">
                サムネは素材からその場で切り出した実際のフレームです。カタログに載っていない素材でも表示されます。
              </p>
            </>
          )}

          {sec === 'keys' && (
            <table className="table">
              <thead>
                <tr>
                  <th>キー</th>
                  <th>できること</th>
                  <th>場所</th>
                </tr>
              </thead>
              <tbody>
                {KEYS.map((k) => (
                  <tr key={k.k}>
                    <td>
                      <code>{k.k}</code>
                    </td>
                    <td>{k.what}</td>
                    <td className="hint">{k.where}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {sec === 'terms' && (
            <dl className="help-terms">
              {TERMS.map((t) => (
                <React.Fragment key={t.t}>
                  <dt>{t.t}</dt>
                  <dd>{t.d}</dd>
                </React.Fragment>
              ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
};
