// Brief：ユーザーの意図（Step 0 の回答）を編集し、プランを生成して cuts.json に書く。
import React, {useMemo, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {ScriptCard} from '../components/ScriptCard';
import {EmptyState} from '../components/EmptyState';
import {useAiModel} from '../hooks/useAiModel';
import {BriefSchema, type Brief, type FormatId, type SavePriority} from '@shared/schema';
import {FORMAT_SPECS, FORMAT_IDS} from '@shared/format-specs';
import {findPersona, getPersona} from '@shared/personas';
import {countChars} from '@shared/telop-text';

const PRIORITIES: {id: SavePriority; label: string}[] = [
  {id: 'access', label: 'アクセス（駅・徒歩）'},
  {id: 'hours', label: '営業時間・定休'},
  {id: 'budget', label: '予算'},
  {id: 'menu', label: '人気メニュー'},
  {id: 'crowd', label: '混雑・予約'},
  {id: 'scene', label: 'シーン（席・雰囲気）'},
  {id: 'howto', label: '注文方法'},
  {id: 'caution', label: '注意点（現金不可等）'},
];

type PlanPreview = {markdown: string; warnings: {code: string; message: string}[]; table: unknown[]; cuts: {cuts: unknown[]}};

export const BriefPage: React.FC<{onGoTimeline: () => void; onTab: (t: 'projects' | 'materials') => void}> = ({onGoTimeline, onTab}) => {
  const s = useStudio();
  const brief = s.files.brief.data;
  const catalog = s.files.catalog.data;
  // 裏で走らせる Claude のモデル（他画面と同じ設定を共有する）
  const [aiModel, changeAiModel] = useAiModel();

  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');

  const set = (patch: Partial<Brief>) => brief && s.setFile('brief', {...brief, ...patch});
  const persona = brief ? (findPersona(brief.persona) ?? null) : null;
  const spec = brief ? FORMAT_SPECS[brief.format ?? persona!.defaultFormat] : null;
  const clips = catalog?.clips ?? [];
  const hookClips = useMemo(() => [...clips].sort((a, b) => Number(b.user.hook) - Number(a.user.hook)), [clips]);

  const createBrief = (personaId: Brief['persona']) => {
    const b = BriefSchema.parse({version: 1, persona: personaId, shop: {name: '', area: '', genre: '', pr: false}, materialMode: 'raw', format: getPersona(personaId).defaultFormat, savePriorities: ['access', 'hours', 'budget']});
    s.setFile('brief', b);
  };

  const runPlan = async (write: boolean) => {
    if (!brief || !s.active) return;
    setBusy(true);
    try {
      if (write && s.files.brief.dirty) {
        const ok = await s.saveFile('brief');
        if (!ok) return;
      }
      const r = await api.post<PlanPreview>(`/api/projects/${s.active}/plan`, {brief: write ? undefined : brief, write});
      setPreview(r.data);
      if (write) {
        await s.loadFile('cuts');
        s.toast('cuts.json に書き込みました。Timeline で確認してください', 'ok');
        onGoTimeline();
      }
    } catch (e) {
      s.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const togglePriority = (id: SavePriority) => {
    if (!brief) return;
    const cur = brief.savePriorities;
    set({savePriorities: cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 4 ? cur : [...cur, id]});
  };
  const toggleNg = (id: string) => brief && set({ngClipIds: brief.ngClipIds.includes(id) ? brief.ngClipIds.filter((x) => x !== id) : [...brief.ngClipIds, id]});

  const buildPrompt = () => {
    if (!brief) return;
    const lines = [
      `人格「${persona!.label}」で、work/${s.active}/ の素材を Studio 連携モードで仕上げてください。`,
      `- brief.json は保存済み（persona=${brief.persona} / ${spec!.id} ${spec!.name} / 尺 ${brief.targetSec ?? spec!.targetSec[1]} 秒目安）`,
      `- 店名：${brief.shop.name}（${brief.shop.area}${brief.shop.genre ? '・' + brief.shop.genre : ''}）${brief.shop.pr ? '【PR案件】' : ''}`,
      brief.core ? `- 企画の核：${brief.core}` : '',
      brief.hook ? `- 冒頭フック：clip ${brief.hook.clipId}${brief.hook.text ? `「${brief.hook.text}」` : '（文言はあなたが Step 2 の型で提案）'}` : '- 冒頭フック：未選定。候補を 2〜4 個提示して私に選ばせてください',
      `- 手順：未タグのクリップがあれば reel tag --export のサムネイルを 1 枚ずつ見てタグ付け → reel plan（カット表を見せて承認）→ --write → {{gNN:intent}} をテロップ規則で埋める → reel validate で E ゼロ → reel draft → reel render → Step 7 ナレーション`,
      brief.notes ? `- 補足：${brief.notes}` : '',
    ].filter(Boolean);
    setPrompt(lines.join('\n'));
  };

  if (!s.active)
    return (
      <div className="page">
        <EmptyState title="案件が開かれていません" steps={['Projects で案件を開く']} action={{label: 'Projects へ', onClick: () => onTab('projects')}} />
      </div>
    );
  if (!brief)
    return (
      <div className="page">
        <section className="card empty-state" data-tour="brief-form">
          <h2>まず「誰の動画か」を選びます</h2>
          <p>
            人格（persona）を選ぶと、文体・声・テロップの色・既定の構成の型がまとめて決まります。あとから変えられます。
          </p>
          <div className="row">
            {s.personas.map((p) => (
              <button key={p.id} className="primary" onClick={() => createBrief(p.id)} title={p.narration.voiceId ? p.tone : 'ナレーションのボイスが未設定です（音声生成で止まります）'}>
                {p.label} で作る{p.narration.voiceId ? '' : '（ボイス未設定）'}
              </button>
            ))}
          </div>
          <p className="hint">人格の追加・編集（文体・声・締めの文言・キャプションの型）は Settings の「人格」でできます</p>
        </section>
        {!catalog && (
          <EmptyState
            title="素材がまだ読み込まれていません"
            steps={['Materials で素材フォルダを選んで「カタログ実行」']}
            action={{label: 'Materials へ', onClick: () => onTab('materials')}}
            hint="カット構成の自動生成には素材のタグが必要です。"
          />
        )}
      </div>
    );

  return (
    <div className="page">
      <section className="card" data-tour="brief-form">
        <div className="row">
          <h2 style={{margin: 0}}>Brief（意図）</h2>
          <span style={{flex: 1}} />
          <button onClick={() => s.loadFile('brief')}>読み直す</button>
          <button className="primary" onClick={() => s.saveFile('brief')} disabled={!s.files.brief.dirty}>
            brief.json を保存
          </button>
          {s.files.brief.external && (
            <button className="warn" onClick={() => s.saveFile('brief', true)}>
              外部変更を上書き
            </button>
          )}
        </div>
        <div className="form">
          <label>
            persona
            <select value={brief.persona} onChange={(e) => set({persona: e.target.value, format: getPersona(e.target.value).defaultFormat})}>
              {!findPersona(brief.persona) && <option value={brief.persona}>{brief.persona}（未登録の人格）</option>}
              {s.personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}（既定 {p.defaultFormat}）
                </option>
              ))}
            </select>
          </label>
          <label>
            フォーマット
            <select value={brief.format ?? persona!.defaultFormat} onChange={(e) => set({format: e.target.value as FormatId})}>
              {FORMAT_IDS.map((id) => (
                <option key={id} value={id}>
                  {id} {FORMAT_SPECS[id].name}（上限 {FORMAT_SPECS[id].maxSec}s）
                </option>
              ))}
            </select>
          </label>
          <label>
            テーマ（空 = {spec!.theme}）
            <select value={brief.theme ?? ''} onChange={(e) => set({theme: (e.target.value || undefined) as Brief['theme']})}>
              <option value="">（推奨 {spec!.theme}）</option>
              {(['pop', 'bold', 'human', 'stylish'] as const).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            目安の尺（秒、{spec!.targetSec[0]}〜{spec!.maxSec}）
            <input type="number" value={brief.targetSec ?? ''} placeholder={String(spec!.targetSec[1])} onChange={(e) => set({targetSec: e.target.value ? Number(e.target.value) : undefined})} />
          </label>
          <label>
            素材の状態
            <select value={brief.materialMode} onChange={(e) => set({materialMode: e.target.value as Brief['materialMode']})}>
              <option value="raw">raw（カット未編集の複数クリップ）</option>
              <option value="precut">precut（カット済みの単一ファイル）</option>
            </select>
          </label>
          <label>
            主役
            <select value={brief.subject} onChange={(e) => set({subject: e.target.value as Brief['subject']})}>
              <option value="anomaly">異常値（価格・量・時間・仕組み・見た目）</option>
              <option value="human">人情・店主</option>
              <option value="scene">シーン提案</option>
              <option value="ranking">ランキング</option>
              <option value="verification">検証</option>
              <option value="news">新店・速報</option>
              <option value="list">まとめ</option>
            </select>
          </label>
          <label>
            店名
            <input value={brief.shop.name} onChange={(e) => set({shop: {...brief.shop, name: e.target.value}})} />
          </label>
          <label>
            エリア
            <input value={brief.shop.area} onChange={(e) => set({shop: {...brief.shop, area: e.target.value}})} />
          </label>
          <label>
            ジャンル
            <input value={brief.shop.genre} onChange={(e) => set({shop: {...brief.shop, genre: e.target.value}})} />
          </label>
          <label>
            <span>PR 案件</span>
            <input type="checkbox" checked={brief.shop.pr} onChange={(e) => set({shop: {...brief.shop, pr: e.target.checked}})} />
          </label>
          <label className="full">
            企画の核（1 行：「（地域）にある、（証明できる数字・仕組み）で（珍しい体験）ができる店」）
            <input value={brief.core} onChange={(e) => set({core: e.target.value})} />
          </label>
        </div>

        <h3>① 冒頭フック（Claude は決めない。ここで選ぶ）</h3>
        <div className="row">
          <label>
            クリップ
            <select value={brief.hook?.clipId ?? ''} onChange={(e) => set({hook: e.target.value ? {...(brief.hook ?? {}), clipId: e.target.value} : undefined})}>
              <option value="">（未選定）</option>
              {hookClips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.user.hook ? '★ ' : ''}
                  {c.id} {c.tags?.description ?? c.slug}（{c.probe.durationSec.toFixed(1)}s）
                </option>
              ))}
            </select>
          </label>
          <label>
            IN 秒
            <input type="number" step={0.05} value={brief.hook?.inSec ?? ''} disabled={!brief.hook} onChange={(e) => set({hook: {...brief.hook!, inSec: e.target.value === '' ? undefined : Number(e.target.value)}})} />
          </label>
          <label>
            OUT 秒
            <input type="number" step={0.05} value={brief.hook?.outSec ?? ''} disabled={!brief.hook} onChange={(e) => set({hook: {...brief.hook!, outSec: e.target.value === '' ? undefined : Number(e.target.value)}})} />
          </label>
          <label style={{minWidth: 320}}>
            確定フック文（空なら Claude が提案。エリア名＋一桁数字型）
            <input value={brief.hook?.text ?? ''} disabled={!brief.hook} onChange={(e) => set({hook: {...brief.hook!, text: e.target.value || undefined}})} />
            <span className={`counter${countChars(brief.hook?.text ?? '') > 13 ? ' over' : ''}`}>{countChars(brief.hook?.text ?? '')}/13</span>
          </label>
        </div>

        <h3>構成</h3>
        <div className="row">
          <label>
            店名リビール
            <select value={brief.reveal ?? ''} onChange={(e) => set({reveal: (e.target.value || undefined) as Brief['reveal']})}>
              <option value="">（{spec!.reveal === 'late' ? '終盤（F7）' : spec!.reveal === 'afterProof' ? '②直後' : 'なし'} = フォーマット既定）</option>
              <option value="afterProof">②直後</option>
              <option value="late">終盤まで隠す（F7）</option>
            </select>
          </label>
          <label>
            <span>会話・語りクリップを使う（保護規則）</span>
            <input type="checkbox" checked={brief.speech.use} onChange={(e) => set({speech: {...brief.speech, use: e.target.checked}})} />
          </label>
          <label>
            並び順
            <select value={brief.order.mode} onChange={(e) => set({order: {...brief.order, mode: e.target.value as Brief['order']['mode']}})}>
              <option value="auto">auto（型どおりに自動）</option>
              <option value="hint">hint（Materials の並び順ヒントを優先）</option>
              <option value="fixed">fixed（下の順で固定）</option>
            </select>
          </label>
          {brief.order.mode === 'fixed' && (
            <label style={{flex: 1}}>
              固定順（clip id をカンマ区切り）
              <input value={(brief.order.fixed ?? []).join(',')} onChange={(e) => set({order: {...brief.order, fixed: e.target.value.split(/[,\s、]+/).filter(Boolean)}})} />
            </label>
          )}
        </div>
        <h3>③ 保存する理由の優先順位（最大 4。クリック順）</h3>
        <div className="chips">
          {PRIORITIES.map((p) => {
            const idx = brief.savePriorities.indexOf(p.id);
            return (
              <span key={p.id} className={`chip${idx >= 0 ? ' on' : ''}`} onClick={() => togglePriority(p.id)}>
                {idx >= 0 ? `${idx + 1}. ` : ''}
                {p.label}
              </span>
            );
          })}
        </div>
        <h3>使わない素材（NG）</h3>
        <div className="chips">
          {clips.map((c) => (
            <span key={c.id} className={`chip${brief.ngClipIds.includes(c.id) || c.user.ng ? ' on' : ''}`} onClick={() => toggleNg(c.id)} title={c.tags?.description ?? c.slug}>
              {c.id}
            </span>
          ))}
        </div>

        {spec!.repeat && (
          <>
            <h3>{spec!.repeat.unitLabel}ブロック（{spec!.id}：{spec!.repeat.count[0]}〜{spec!.repeat.count[1]} 個）</h3>
            {(brief.units ?? []).map((u, i) => (
              <div className="row" key={i}>
                <label>
                  ラベル
                  <input value={u.label} onChange={(e) => set({units: brief.units!.map((x, k) => (k === i ? {...x, label: e.target.value} : x))})} />
                </label>
                <label>
                  バッジ（第3位 / ①店名）
                  <input value={u.badge} onChange={(e) => set({units: brief.units!.map((x, k) => (k === i ? {...x, badge: e.target.value} : x))})} />
                </label>
                <label style={{flex: 1}}>
                  clip id（カンマ区切り）
                  <input value={u.clipIds.join(',')} onChange={(e) => set({units: brief.units!.map((x, k) => (k === i ? {...x, clipIds: e.target.value.split(/[,\s、]+/).filter(Boolean)} : x))})} />
                </label>
                <button className="small danger" onClick={() => set({units: brief.units!.filter((_, k) => k !== i)})}>
                  ×
                </button>
              </div>
            ))}
            <button className="small" onClick={() => set({units: [...(brief.units ?? []), {label: '', badge: '', clipIds: []}]})}>
              + ブロック
            </button>
          </>
        )}

        {brief.materialMode === 'precut' && (
          <>
            <h3>カット済み素材の確定テロップ（一字一句そのまま使う）</h3>
            {(brief.precut?.fixedTelops ?? []).map((t, i) => (
              <div className="row" key={i}>
                <label>
                  秒
                  <input type="number" step={0.1} value={t.atSec ?? ''} onChange={(e) => set({precut: {...brief.precut!, fixedTelops: brief.precut!.fixedTelops.map((x, k) => (k === i ? {...x, atSec: e.target.value === '' ? undefined : Number(e.target.value)} : x))}})} />
                </label>
                <label style={{flex: 1}}>
                  文言
                  <input value={t.text} onChange={(e) => set({precut: {...brief.precut!, fixedTelops: brief.precut!.fixedTelops.map((x, k) => (k === i ? {...x, text: e.target.value} : x))}})} />
                </label>
                <button className="small danger" onClick={() => set({precut: {...brief.precut!, fixedTelops: brief.precut!.fixedTelops.filter((_, k) => k !== i)}})}>
                  ×
                </button>
              </div>
            ))}
            <button className="small" onClick={() => set({precut: {keepOrder: true, durationPolicy: brief.precut?.durationPolicy ?? 'asIs', fixedTelops: [...(brief.precut?.fixedTelops ?? []), {text: ''}]}})}>
              + テロップ
            </button>
          </>
        )}

        <h3>ファクト（テロップ・キャプションの根拠。key: value）</h3>
        {Object.entries(brief.facts).map(([k, v]) => (
          <div className="row" key={k}>
            <input value={k} readOnly style={{width: 120}} />
            <input style={{flex: 1}} value={v} onChange={(e) => set({facts: {...brief.facts, [k]: e.target.value}})} />
            <button
              className="small danger"
              onClick={() => {
                const f = {...brief.facts};
                delete f[k];
                set({facts: f});
              }}
            >
              ×
            </button>
          </div>
        ))}
        <div className="row">
          <button
            className="small"
            onClick={() => {
              const k = window.prompt('キー（station / hours / budget / menu / …）');
              if (k) set({facts: {...brief.facts, [k]: ''}});
            }}
          >
            + ファクト
          </button>
        </div>
        <label className="full" style={{display: 'flex', marginTop: 8}}>
          補足メモ（Claude への指示）
          <textarea value={brief.notes ?? ''} onChange={(e) => set({notes: e.target.value || undefined})} />
        </label>
      </section>

      <ScriptCard aiModel={aiModel} onModel={changeAiModel} />

      <section className="card" data-tour="brief-plan">
        <h2>プラン（型に流し込む）</h2>
        <p className="hint">
          上の意図と素材のタグから、フォーマット（F0 等）の型どおりにカットの並びを自動で組みます。まず「プレビュー」で表を確認し、よければ「cuts.json に書き込む」。テロップの文言はこの時点では仮（{'{{g01:hook}}'} 等）で、Timeline で埋めます。
          <b>台本がもうあるなら、上の「台本から組み立てる」を使ってください</b>（どちらか一方です）。
        </p>
        <div className="row">
          <button className="primary" onClick={() => runPlan(false)} disabled={busy || !catalog}>
            プランを生成（プレビュー）
          </button>
          <button className="primary" onClick={() => runPlan(true)} disabled={busy || !catalog}>
            cuts.json に書き込む（brief 保存 → plan → Timeline へ）
          </button>
          <button onClick={buildPrompt}>Claude 用の依頼文を作る</button>
          {!catalog && <span className="hint">先に Materials でカタログ化してください</span>}
        </div>
        {preview && (
          <>
            <div className="hint">
              {preview.cuts.cuts.length} カット / warnings {preview.warnings.length}
            </div>
            {preview.warnings.map((w, i) => (
              <div key={i} className="issue W">
                <span className="code">{w.code}</span>
                <span>{w.message}</span>
              </div>
            ))}
            <pre className="md">{preview.markdown}</pre>
          </>
        )}
        {prompt && (
          <>
            <textarea value={prompt} readOnly style={{minHeight: 140}} />
            <button className="small" onClick={() => navigator.clipboard.writeText(prompt).then(() => s.toast('コピーしました', 'ok'))}>
              コピー
            </button>
          </>
        )}
      </section>
    </div>
  );
};
