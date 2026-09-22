// 「? 使い方」パネル。全体の流れ・タイムラインの読み方・ショートカット・用語をまとめて置く。
// 初めての人が「この画面は何をするところか」を後から確認できる場所。
import React, {useEffect, useState} from 'react';
import type {TourTab} from './Tour';

const FLOW: {tab: TourTab; label: string; what: string}[] = [
  {tab: 'projects', label: '① Projects', what: '案件（動画 1 本）を作る・開く。同じ素材で別バージョンも作れる。投稿し終えた案件は「投稿済み（隠す）」で一覧から外せる（消えません）'},
  {tab: 'materials', label: '② Materials', what: '素材フォルダを読み込み、1 本ずつタグを付ける（AI に任せられる）'},
  {tab: 'brief', label: '③ Brief', what: '何を伝えるかを決めて構成を自動生成する。台本があるなら貼って「台本から組み立てる」。他の人のバズ動画を渡して型を写すこともできる'},
  {tab: 'timeline', label: '④ Timeline', what: '映像・テロップ・ナレーション・効果音を 1 つのタイムラインで整えて検証する'},
  {tab: 'render', label: '⑤ Render', what: '「仕上げ」で原稿 → 音声 → レンダー → 合成 → 納品まで一気に。声の設定・効果音・キャプション・トライアルもここ'},
  {tab: 'settings', label: '⑥ Settings', what: 'データフォルダ・Fish Audio の API キー・claude の場所と既定モデル・人格（文体・声・キャプションの型）。最初に一度だけ'},
];

const KEYS: {k: string; what: string; where: string}[] = [
  {k: 'Ctrl + S', what: '編集中のファイルを保存', where: 'Timeline／Materials／Brief'},
  {k: 'Ctrl + Z / Ctrl + Y', what: '取り消し／やり直し（並び・尺・テロップ・ナレーション・効果音の変更）', where: 'Timeline'},
  {k: 'Space', what: '再生／一時停止', where: 'Timeline'},
  {k: '← →（Shift で 10）', what: '1 コマ戻る／進む', where: 'Timeline（入力欄の外）'},
  {k: 'Home / End', what: '先頭／末尾へ', where: 'Timeline'},
  {k: 'Delete', what: '選んでいるもの（カット・ナレーション・効果音）を消す', where: 'Timeline'},
  {k: 'S', what: '再生ヘッドの位置でカットを分割', where: 'Timeline'},
  {k: 'Ctrl + D', what: '選んでいるカットを複製', where: 'Timeline'},
  {k: 'Alt + ← →', what: 'カードにフォーカスしたカットを 1 つ前後へ', where: 'Timeline の V 段／絵コンテ'},
  {k: 'Esc', what: '選択を外す／ドラッグを取り消す／ツアーを閉じる', where: '全体'},
  {k: 'ドラッグ', what: '素材カードを V 段に落として追加（青い縦線の位置に入る）', where: 'Timeline の素材ビン'},
  {k: 'ドラッグ', what: 'ブロックの両端で尺（IN/OUT）、中を掴んで並べ替え、Alt+ドラッグで中身をずらす', where: 'V 段'},
  {k: 'ドラッグ', what: '横に動かして配置秒を変える。カット境界に吸着（Alt で無効）', where: 'N 段・S 段'},
  {k: 'クリック', what: 'そのブロックを選んでその場面へ', where: '全部の段'},
  {k: 'Ctrl + ホイール', what: '拡大・縮小（ポインタの下の時刻を動かさない）', where: 'タイムライン'},
  {k: '← →（つまみ選択中）', what: '1 フレームずつ／Shift で 10 フレーム', where: 'インスペクタのフィルム帯'},
  {k: 'Ctrl + 1〜6', what: 'タブを切り替える', where: '全体'},
  {k: '?', what: 'このパネルを開く', where: '全体'},
];

const TERMS: {t: string; d: string}[] = [
  {t: 'カット', d: '1 つの素材から切り出した 1 区間。これを並べたものが動画になる'},
  {t: 'フック', d: '冒頭の掴み。ここで見るのをやめられるかが決まるので一番大事な 1〜2 カット'},
  {t: 'リビール', d: '店名や正体を明かす場面。発見型（F7）では終盤まで隠す'},
  {t: 'テロップグループ', d: '同じ文言が続くカットのまとまり。T 段の 1 ブロック。1 カット 1 文言だと速すぎて読めないため、複数カットにまたがらせる'},
  {t: 'slot / role', d: '各カットの役割（フック・証拠・シズル・情報・CTA…）。構成の型から自動で割り当てられる'},
  {t: 'プロキシ', d: '4K や HEVC の重い素材から作る軽い H.264 版。プレビューとレンダーを安定させる'},
  {t: 'alias', d: '同じ素材を離れた位置で 2 回使うときの別名コピー。Remotion が不安定になるのを避けるため'},
  {t: 'E / W', d: 'E＝エラー（直さないと書き出せない）、W＝警告（直した方がよい）'},
  {t: 'ドラフト', d: '0.25 倍の粗いレンダー。全体の流れを速く確認するためのもの'},
  {t: 'mix（合成）', d: 'レンダーした映像に声と効果音を混ぜる工程。レンダーだけでは素材の音しか入っていない'},
  {t: '仕上げ', d: 'Render の一気通貫。案件の状態から残っている工程だけを順に走らせて outputs/ に納品する'},
  {t: '要再生成', d: 'ナレーションの文言・ボイス・速度を変えたので wav を作り直す必要がある印。そのまま mix すると古い声が混ざる'},
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
  const [sec, setSec] = useState<'flow' | 'timeline' | 'keys' | 'terms'>('flow');

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
              ['timeline', 'タイムラインの見方'],
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
              <h3>台本から作る場合</h3>
              <p className="hint">
                Brief の「台本から組み立てる」に台本を貼る → cuts と narration ができる → Timeline で確認・微調整 → Render の「仕上げ」を押す。この 3 手で完成動画が outputs/ に出ます。
              </p>
              <h3>バズった動画の型を写す場合</h3>
              <p className="hint">
                Brief の「バズ動画の型を写す」に他の人の伸びたリールを渡す → 型（区間・カット数・テロップの型・フック・締め）を分析 →「この型で台本を作って組み立てる」で自分の素材の cuts と narration ができる。
                写すのは型だけで、映像・音声・文言そのものは使いません。
              </p>
              <h3>Claude に任せられるところ</h3>
              <ul className="tour-list">
                <li>素材のタグ付け（Materials の「AI にタグ付けしてもらう」。裏で Claude が起動してサムネイルを 1 枚ずつ見ます）</li>
                <li>台本からの組み立て（Brief。素材のタグと台本を突き合わせて cuts と narration を作ります）</li>
                <li>バズ動画の型の分析と、その型を写した台本（Brief の「バズ動画の型を写す」）</li>
                <li>テロップの文言・ナレーション原稿・並べ替え・自由な直し（Timeline の「AI ▾」）</li>
                <li>キャプションと店舗情報の裏取り（Render）</li>
                <li className="hint">いずれも API 課金が発生します。モデルは横のプルダウンで選べます（opus が既定）。AI の文言は下書き扱いなので必ず読み直してください</li>
              </ul>
              <h3>表示の設定</h3>
              <label className="sb-inline">
                <input type="checkbox" checked={!nextBarHidden} onChange={(e) => onNextBar(e.target.checked)} />
                <span>画面上に「次にやること」を表示する</span>
              </label>
            </>
          )}

          {sec === 'timeline' && (
            <>
              <p>Timeline 画面の下にある 4 段のトラックです。1 つの時間軸に映像・テロップ・ナレーション・効果音が乗っています。</p>
              <h3>段の意味</h3>
              <ul className="tour-list">
                <li>
                  <b>V（映像）</b>：カットの列。幅＝実時間。両端で尺、中を掴んで並べ替え、Alt+ドラッグで中身をずらす。右上の <code>!</code>＝エラー、<code>?</code>＝警告
                </li>
                <li>
                  <b>T（テロップ）</b>：同じ文言が続く範囲（テロップグループ）。色は絵コンテと同じ。黄色＝未記入、破線＝テロップ無し（クリックでそのカットを選んで書ける）
                </li>
                <li>
                  <b>N（ナレーション）</b>：narration.json のブロック。幅＝実測の秒数（破線は見積もり）。黄色＝要再生成、赤枠＝前と重なる、縞＝動画尺をはみ出す。横にドラッグで配置秒。左の ＋ で再生ヘッドの位置に追加
                </li>
                <li>
                  <b>S（効果音）</b>：narration.json の sfx。赤＝音源が無い。横にドラッグで配置秒
                </li>
              </ul>
              <h3>右のインスペクタ</h3>
              <ul className="tour-list">
                <li>カット：素材・フィルム帯（IN/OUT）・倍速・テロップ文・向き・バッジ・複製／分割／削除／固定</li>
                <li>テロップグループ：文言（グループ内の全カットに入る）・向き・バッジ。1 カットだけ変えたいときは V 段でそのカットを選ぶ</li>
                <li>ナレーション：本文・id・配置秒・聴く・この 1 本だけ生成・削除</li>
                <li>効果音：音源・役割・配置秒・尺・音量・fade</li>
                <li>何も選んでいない：テーマ・バッジの濃さ・ショートカット</li>
                <li>その下の「検証」：カット／構成／ナレーション／効果音の指摘。行をクリックでその場面へ</li>
              </ul>
              <h3>合成音</h3>
              <p className="hint">
                トランスポートの「合成音」が ON だと、再生に合わせて生成済みのナレーション wav と効果音を重ねて鳴らします（素材の音は環境音の音量に下げます）。音声が未生成のブロックは鳴りません。レンダーには入りません（声は Render の mix で載せます）。
              </p>
              <h3>絵コンテ</h3>
              <p className="hint">ツールバーの「絵コンテ」でサムネ一覧を出せます。テロップ単位でまとめて動かすときはこちらが速い（ドラッグで並べ替え、Alt+←→ で 1 つずつ）。</p>
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
                {KEYS.map((k, i) => (
                  <tr key={i}>
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
