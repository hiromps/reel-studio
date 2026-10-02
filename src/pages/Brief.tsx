// Brief：ユーザーの意図（Step 0 の回答）を編集し、構成を作る。
//
// 画面の並び（上から順に進む）:
//   1. 作り方の流れ（6 工程の済み／いま。構成の作り方を 3 つから 1 つ選ぶ）
//   2. Brief（意図）の入力
//   3. 選んだ作り方のカード（台本から組み立てる／バズ動画の型を写す／プラン＝型に流し込む）。残りの 2 つは畳んで下に置く
import React, {useCallback, useMemo, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import {ScriptCard, type ScriptCardState} from '../components/ScriptCard';
import {ReferenceCard, type ReferenceCardState} from '../components/ReferenceCard';
import {EmptyState} from '../components/EmptyState';
import {BriefFlow} from '../components/BriefFlow';
import {briefFlowOf, isBriefRoute, recommendRoute, ROUTE_INFO, ROUTE_ORDER, type BriefRoute} from '../components/briefSteps';
import type {StepTab} from '../components/nextStep';
import {useAiModel} from '../hooks/useAiModel';
import {useStringPref} from '../hooks/usePref';
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

/** 同じ画面のカードへスクロール。畳んだ「別の作り方」の中なら開いてから */
const scrollToTour = (tour: string) => {
  const el = document.querySelector<HTMLElement>(`[data-tour="${tour}"]`);
  if (!el) return;
  for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) if (!d.open) d.open = true;
  el.scrollIntoView({behavior: 'smooth', block: 'start'});
};

export const BriefPage: React.FC<{onGoTimeline: () => void; onTab: (t: StepTab) => void}> = ({onGoTimeline, onTab}) => {
  const s = useStudio();
  const brief = s.files.brief.data;
  const catalog = s.files.catalog.data;
  // 裏で走らせる Claude のモデル（他画面と同じ設定を共有する）
  const [aiModel, changeAiModel] = useAiModel();

  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');

  // 台本・参考動画の有無（カードが読んだ結果を受け取る。「作り方の流れ」の判定に使う）
  const [scriptState, setScriptState] = useState<ScriptCardState>({hasText: false, sections: 0});
  const [refState, setRefState] = useState<ReferenceCardState>({present: false, analyzed: false});
  const onScriptState = useCallback((st: ScriptCardState) => setScriptState(st), []);
  const onRefState = useCallback((st: ReferenceCardState) => setRefState(st), []);

  // 構成の作り方。案件ごとにブラウザが覚える。選んでいなければ状態からの推奨
  const [routePref, setRoutePref] = useStringPref(`reel-studio.brief.route.${s.active ?? ''}`, '');
  const recommended = recommendRoute({hasScript: scriptState.hasText, referencePresent: refState.present, referenceAnalyzed: refState.analyzed});
  const route: BriefRoute = isBriefRoute(routePref) ? routePref : recommended;
  const project = s.projects.find((p) => p.slug === s.active);
  const steps = useMemo(
    () =>
      briefFlowOf(
        {
          catalog,
          brief,
          briefDirty: s.files.brief.dirty,
          cuts: s.files.cuts.data,
          narration: s.files.narration.data,
          hasScript: scriptState.hasText,
          referencePresent: refState.present,
          referenceAnalyzed: refState.analyzed,
          finalOut: !!project?.out?.final,
        },
        route,
      ),
    [catalog, brief, s.files.brief.dirty, s.files.cuts.data, s.files.narration.data, scriptState.hasText, refState.present, refState.analyzed, project?.out?.final, route],
  );
  const chooseRoute = (r: BriefRoute) => {
    setRoutePref(r);
    // 選んだカードがすぐ下に出るので、そこへ
    setTimeout(() => scrollToTour(ROUTE_INFO[r].tour), 50);
  };

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

  /**
   * Claude Code のターミナル（自分のスキル）で進める人向けの依頼文。Reel Studio の画面内の AI 機能を使うなら要らない。
   * 貼り先は PC の別ターミナルで起動した claude（Studio 連携モードのスキルが reel コマンドで案件を進める）
   */
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

  const flow = <BriefFlow steps={steps} route={route} recommended={recommended} onRoute={chooseRoute} persona={persona} onTab={onTab} scrollTo={scrollToTour} />;

  if (!brief)
    return (
      <div className="page">
        {flow}
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

  // ── 構成の作り方のカード（選んだものを先頭に、残りは畳む） ──
  const planCard = (
    <section className="card" data-tour="brief-plan">
      <div className="summary">
        <span>
          <b>プラン（型に流し込む）</b>
        </span>
        {route === 'plan' && <span className="flow-primary-tag">いまの作り方</span>}
        <span className="hint">台本も参考動画も無いときの作り方。人格の既定の型（{spec!.id} {spec!.name}）どおりにカットを並べます</span>
      </div>
      <p className="hint">
        上の意図と素材のタグから、フォーマット（{spec!.id} 等）の型どおりにカットの並び（順番・尺・役割）を自動で組みます。
        <b>テロップの文言はこの時点では仮置き</b>（{'{{g01:hook}}'} 等）で、次に Timeline の「Claude に頼む → テロップを書いてもらう」が人格の文体で埋め、そのあと「ナレーション原稿」を書きます。
        先に「① 冒頭フック」でクリップを選んでおくと、冒頭が型どおりに決まります。
      </p>
      <ol className="empty-steps">
        <li>「プランを生成（プレビュー）」で、カット表と注意（W）を見る</li>
        <li>よければ「cuts.json に書き込む」（brief を保存 → 並びを書く → Timeline へ移ります）</li>
        <li>Timeline の「Claude に頼む」でテロップ → ナレーション原稿。Render の「仕上げ」で音声・レンダー・納品</li>
      </ol>
      <div className="row">
        <button className="primary" onClick={() => runPlan(false)} disabled={busy || !catalog}>
          プランを生成（プレビュー）
        </button>
        <button className="primary" onClick={() => runPlan(true)} disabled={busy || !catalog}>
          cuts.json に書き込む（brief 保存 → plan → Timeline へ）
        </button>
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

      <details style={{marginTop: 8}}>
        <summary className="hint">Claude Code のターミナルで進める人向け（上級。画面の AI 機能を使うなら不要）</summary>
        <p className="hint">
          Reel Studio の中の「Claude に頼む」「台本から組み立てる」を使うなら、この依頼文は要りません。
          自分の Claude Code スキル（hiro-daihon など、Studio 連携モードに対応したもの）で進めたいときだけ使います。
        </p>
        <ol className="empty-steps">
          <li>
            先に上の「brief.json を保存」を押す（依頼文は保存済みの brief を前提にしています）
          </li>
          <li>
            PC で別のターミナルを開き、Reel Studio のフォルダ（このリポジトリ）で <span className="mono">claude</span> を起動する
          </li>
          <li>「依頼文を作る」→「コピー」で、その claude の入力欄に貼って送る。Claude Code が <span className="mono">reel</span> コマンドで案件を進め、この画面は自動で追従します（Timeline で途中経過が見えます）</li>
        </ol>
        <div className="row">
          <button onClick={buildPrompt}>依頼文を作る</button>
          {prompt && (
            <button className="small" onClick={() => navigator.clipboard.writeText(prompt).then(() => s.toast('コピーしました。Claude Code のターミナルに貼ってください', 'ok'))}>
              コピー
            </button>
          )}
        </div>
        {prompt && <textarea value={prompt} readOnly style={{minHeight: 140, width: '100%'}} />}
      </details>
    </section>
  );
  const cardOf: Record<BriefRoute, React.ReactNode> = {
    script: <ScriptCard aiModel={aiModel} onModel={changeAiModel} onState={onScriptState} primary={route === 'script'} />,
    reference: <ReferenceCard aiModel={aiModel} onModel={changeAiModel} onState={onRefState} primary={route === 'reference'} />,
    plan: planCard,
  };
  const ordered: BriefRoute[] = [route, ...ROUTE_ORDER.filter((r) => r !== route)];

  return (
    <div className="page">
      {flow}

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
          <label className="grow">
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
            <label className="grow">
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
                <label className="grow">
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
                <label className="grow">
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
        {/* キーと値は必ず横並びに保つ（縦に積むとどの値がどのキーのものか分からなくなる） */}
        {Object.entries(brief.facts).map(([k, v]) => (
          <div className="fact-row" key={k}>
            <input className="fact-key" value={k} readOnly aria-label="キー" />
            <input className="fact-value" value={v} onChange={(e) => set({facts: {...brief.facts, [k]: e.target.value}})} aria-label={`${k} の値`} />
            <button
              className="small danger"
              aria-label={`${k} を削除`}
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

      {/*
        選んだ作り方のカードを先頭に。残りは畳んで置く（どれか 1 つしか使わないので、並べて迷わせない）。
        3 枚とも**同じ details で包んだまま**並び替える（key で入れ替わるだけ）。包み方を変えると React がカードを作り直し、
        カードが読んだ台本・参考動画の状態が消えて「おすすめ」が行ったり来たりする
      */}
      {ordered.map((id) => {
        const primary = id === route;
        return (
          <details key={id} className={primary ? 'route-primary' : 'route-alt'} open={primary || undefined}>
            <summary>
              別の作り方: <b>{ROUTE_INFO[id].title}</b> — {ROUTE_INFO[id].when}（開いて使うなら、上の「構成の作り方」でこれを選んでください）
            </summary>
            {cardOf[id]}
          </details>
        );
      })}
    </div>
  );
};
