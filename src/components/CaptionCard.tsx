// caption.txt の生成・編集・コピー。保存済みの内容と点検結果はストアが持ち、編集中の文字列だけここで持つ。
import React, {useEffect, useState} from 'react';
import {useStudio} from '../state/store';
import {hashtagsOf} from '@shared/caption';

export const CaptionCard: React.FC<{aiModel: string}> = ({aiModel}) => {
  const s = useStudio();
  const savedText = s.caption.text ?? '';
  const [text, setText] = useState(savedText);
  const [touched, setTouched] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [copied, setCopied] = useState(false);
  // 住所・営業時間は Web で裏取りしてから書く（既定 ON）。Instagram を Google マップより優先する
  const [research, setResearch] = useState(true);
  const [researchForce, setResearchForce] = useState(false);
  const dirty = text !== savedText;
  const busy = s.jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.type === 'ai-caption');
  const unsupported = !s.supportsJob('ai-caption');

  // 保存済みが変わったら取り込む。ただし自分で編集中のときは黙って上書きしない
  useEffect(() => {
    if (!touched) setText(savedText);
  }, [savedText, touched]);

  const run = () => {
    if (busy || unsupported) return;
    void s.addJob('ai-caption', {model: aiModel, instruction: instruction.trim() || undefined, research, researchForce});
    setTouched(false); // 生成結果を受け取れるようにする
  };
  const factsOnly = () => {
    if (busy || !s.supportsJob('ai-facts')) return;
    void s.addJob('ai-facts', {model: aiModel, force: researchForce});
  };
  // 直近の裏取り結果（食い違い・確認できなかった項目）をカードに出す
  const lastFacts = s.jobs.find((j) => (j.type === 'ai-facts' || j.type === 'ai-caption') && j.status === 'done')?.result as
    | {added?: string[]; conflicts?: {key: string; chose: string; detail: string}[]; unresolved?: string[]; factsAdded?: number}
    | undefined;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      s.toast('クリップボードにコピーできませんでした（テキストを選んで Ctrl+C）', 'error');
    }
  };

  if (!s.active) return null;
  const chars = [...text.replace(/\s/g, '')].length;
  const tags = hashtagsOf(text).length;

  return (
    <section className="card" style={{marginTop: 8}} data-tour="caption">
      <div className="summary">
        <span>
          <b>キャプション</b>
        </span>
        <span>{text ? `${chars} 文字 / ハッシュタグ ${tags} 個` : '未作成'}</span>
        <span className="hint">Instagram にそのまま貼れる本文（caption.txt）</span>
      </div>
      <div className="row">
        <button className="primary" onClick={run} disabled={busy || unsupported || !s.files.cuts.data}>
          {busy ? 'AI が書いています…' : savedText ? 'AI に書き直してもらう' : 'AI にキャプションを書いてもらう'}
        </button>
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="追加の指示（任意）：例「頂いたものに値段を入れて」"
          style={{flex: 1, minWidth: 220}}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        {unsupported && <span className="pill warn">サーバーが古いプロセスです。再起動してください</span>}
      </div>
      <div className="row">
        <label title="書く前に店の Instagram と Google マップを調べて brief.json の facts に入れます。食い違ったら Instagram を採用します">
          <span>店舗情報を Web で裏取りする</span>
          <input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)} />
        </label>
        <label title="すでに brief.json に入っている値も Web の結果で置き換える（既定は既存を残す＝素材や手入力の方が正しいため）">
          <span>既存の情報も上書きする</span>
          <input type="checkbox" checked={researchForce} onChange={(e) => setResearchForce(e.target.checked)} disabled={!research} />
        </label>
        <button className="small" onClick={factsOnly} disabled={busy || !s.supportsJob('ai-facts')} title="キャプションは書かず、店舗情報だけ調べて brief.json に入れます">
          店舗情報だけ調べる
        </button>
        <span className="hint">
          Instagram &gt; Google マップの順で信用します（素材映像から読めた事実はそれより強い）
          {s.config?.instagramMcp ? '。Instagram は Smartgram MCP 経由で直接読みます' : '。Settings の「Instagram の情報取得」に Smartgram の鍵を入れると、Instagram をログイン壁に阻まれずに読めます'}
        </span>
      </div>
      {lastFacts && (lastFacts.conflicts?.length || lastFacts.unresolved?.length) && (
        <div className="issues" style={{marginTop: 6}}>
          {lastFacts.conflicts?.map((c, k) => (
            <div key={`c${k}`} className="issue W">
              <span className="code">W 食い違い</span>
              <span>
                {c.key}: {c.detail} → {c.chose} を採用
              </span>
            </div>
          ))}
          {lastFacts.unresolved?.map((u, k) => (
            <div key={`u${k}`} className="issue W">
              <span className="code">W 確認できず</span>
              <span>{u}（brief の facts に手で入れると次から使われます）</span>
            </div>
          ))}
        </div>
      )}
      <textarea
        className="caption-box"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setTouched(true);
        }}
        placeholder="AI に書かせるか、ここに直接書く"
        spellCheck={false}
      />
      <div className="row" style={{marginTop: 6}}>
        <button onClick={() => void copy()} disabled={!text}>
          {copied ? 'コピーしました' : '本文をコピー'}
        </button>
        <span style={{flex: 1}} />
        <button
          onClick={() => {
            setTouched(false);
            void s.loadCaption();
          }}
        >
          読み直す
        </button>
        <button
          className="primary"
          onClick={async () => {
            if (await s.saveCaption(text)) setTouched(false);
          }}
          disabled={!dirty}
        >
          caption.txt を保存
        </button>
      </div>
      {s.caption.issues.length > 0 && (
        <div className="issues" style={{marginTop: 6}}>
          {s.caption.issues.map((i, k) => (
            <div key={k} className={`issue ${i.severity}`}>
              <span className="code">
                {i.severity} {i.code}
              </span>
              <span>{i.message}</span>
            </div>
          ))}
        </div>
      )}
      {dirty && <span className="hint">未保存の変更があります（点検は保存後の内容に対して出ます）</span>}
    </section>
  );
};
