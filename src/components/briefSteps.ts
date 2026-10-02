// Brief の「作り方の流れ」。案件の状態から、6 つの工程のどこまで済んでいるかと、構成の作り方（3 つのうちどれか）を決める。
// 画面に触らない純粋な判定なのでテストできる（「次にやること」の nextStep.ts と同じ作り）。
//
// 作り方は 3 つあって**どれか 1 つ**を使う（混ぜると cuts.json を取り合う）:
//   script    … 台本がある → 台本から組み立てる（cuts + narration が一度にできる）
//   reference … 真似したいバズ動画がある → 型を分析 → 同じ型の台本を書いて組み立てる
//   plan      … どちらも無い → 人格の型（F0〜F7）に素材を流し込む → Timeline でテロップ → ナレーション
import type {Brief, Catalog, Narration, ReelData} from '@shared/schema';
import type {Persona} from '@shared/personas';
import {FORMAT_SPECS} from '@shared/format-specs';
import {countPlaceholders, countUntagged, type StepTab} from './nextStep';

export type BriefRoute = 'script' | 'reference' | 'plan';
export const ROUTE_ORDER: BriefRoute[] = ['script', 'reference', 'plan'];
export const isBriefRoute = (v: unknown): v is BriefRoute => v === 'script' || v === 'reference' || v === 'plan';

export type RouteInfo = {
  id: BriefRoute;
  title: string;
  /** こんなときに使う */
  when: string;
  /** 何ができるか */
  makes: string;
  /** そのあと何をするか */
  then: string;
  /** 画面のカードの data-tour 値（スクロール先） */
  tour: string;
};

export const ROUTE_INFO: Record<BriefRoute, RouteInfo> = {
  script: {
    id: 'script',
    title: '台本から組み立てる',
    when: '台本がある（自分で書いた・Claude に書かせた・既存の動画を書き起こした）',
    makes: '台本の区間ごとに素材を割り当て、テロップとナレーションを台本どおりに入れます（cuts と narration が一度にできる）',
    then: 'Timeline で確認・微調整 → Render の「仕上げ」',
    tour: 'script',
  },
  reference: {
    id: 'reference',
    title: 'バズ動画の型を写す',
    when: '真似したい他の人のリールがある',
    makes: '型（区間・カット数・テロップの型・締め）を分析し、人格の文体と自分の素材で同じ型の台本を書いて、そのまま組み立てます',
    then: 'Timeline で確認・微調整 → Render の「仕上げ」',
    tour: 'reference',
  },
  plan: {
    id: 'plan',
    title: 'プラン（型に流し込む）',
    when: '台本も参考動画も無く、素材と人格の既定の型（F0〜F7）から始める',
    makes: '型どおりの並び（カット順・尺・役割）だけを作ります。テロップは仮置き（{{g01:hook}} の形）',
    then: 'Timeline の「Claude に頼む」でテロップ → ナレーション原稿 → Render の「仕上げ」',
    tour: 'brief-plan',
  },
};

export type FlowSnapshot = {
  catalog: Catalog | null;
  brief: Brief | null;
  briefDirty: boolean;
  cuts: ReelData | null;
  narration: Narration | null;
  /** script.md に中身があるか */
  hasScript: boolean;
  /** 参考動画を取り込んであるか／分析まで済んでいるか */
  referencePresent: boolean;
  referenceAnalyzed: boolean;
  /** 本番レンダー（out/final）があるか */
  finalOut: boolean;
};

/** 状態からの推奨。参考動画があればそれ、台本があればそれ、どちらも無ければ型に流し込む */
export const recommendRoute = (snap: Pick<FlowSnapshot, 'hasScript' | 'referencePresent' | 'referenceAnalyzed'>): BriefRoute =>
  snap.referenceAnalyzed || snap.referencePresent ? 'reference' : snap.hasScript ? 'script' : 'plan';

export type FlowStatus = 'done' | 'now' | 'todo';

export type FlowStep = {
  id: 'materials' | 'brief' | 'build' | 'telop' | 'narration' | 'finish';
  label: string;
  status: FlowStatus;
  /** いまの状態の説明（1〜2 文） */
  detail: string;
  /** 行き先。tour があれば同じ画面のカードへスクロール */
  action?: {label: string; tab: StepTab; tour?: string};
};

/** 6 工程の済み／いま／これから。「いま」は最初の未完了 */
export const briefFlowOf = (snap: FlowSnapshot, route: BriefRoute): FlowStep[] => {
  const info = ROUTE_INFO[route];
  const clips = snap.catalog?.clips.length ?? 0;
  const untagged = snap.catalog ? countUntagged(snap.catalog) : 0;
  const cutsCount = snap.cuts?.cuts.length ?? 0;
  const placeholders = snap.cuts ? countPlaceholders(snap.cuts) : 0;
  const narr = snap.narration?.segments.length ?? 0;
  const briefOk = !!snap.brief && !snap.briefDirty && !!snap.brief.shop.name.trim();

  type Raw = Omit<FlowStep, 'status'> & {done: boolean};
  const raw: Raw[] = [
    {
      id: 'materials',
      label: '素材を読み込んでタグを付ける',
      done: clips > 0 && untagged === 0,
      detail: !clips
        ? 'Materials で素材フォルダを選んで「カタログ実行」。続けて「AI にタグ付けしてもらう」（何が映っているかの記録。台本との突き合わせと型の割り当てに使います）'
        : untagged > 0
          ? `タグの無い素材が ${untagged} 本あります。Materials の「AI にタグ付けしてもらう」で埋めると、素材の当たりが良くなります`
          : `${clips} 本・タグ済み`,
      action: {label: 'Materials へ', tab: 'materials'},
    },
    {
      id: 'brief',
      label: '人格と意図（Brief）を決めて保存',
      done: briefOk,
      detail: !snap.brief
        ? '人格（誰の声・文体で作るか）を選びます'
        : !snap.brief.shop.name.trim()
          ? '店名・エリア・企画の核を入れて「brief.json を保存」。人格の文体・締め・フックの型は、ここから先の AI の文言すべてに効きます'
          : snap.briefDirty
            ? '未保存の変更があります。「brief.json を保存」を押してください'
            : `人格「${snap.brief.persona}」・${snap.brief.shop.name}（保存済み）`,
      action: {label: 'Brief の入力欄へ', tab: 'brief', tour: 'brief-form'},
    },
    {
      id: 'build',
      label: `構成を作る：${info.title}`,
      done: cutsCount > 0,
      detail: cutsCount > 0 ? `${cutsCount} カットあります。作り直すときは同じ作り方で（上書きになります）` : `${info.makes}。${route === 'plan' ? '先に「① 冒頭フック」のクリップを選んでおくと、型どおりに冒頭が決まります' : ''}`.trim(),
      action: {label: `${info.title} へ`, tab: 'brief', tour: info.tour},
    },
    {
      id: 'telop',
      label: 'テロップを入れる',
      done: cutsCount > 0 && placeholders === 0,
      detail:
        route === 'plan'
          ? placeholders > 0
            ? `仮置きのテロップが ${placeholders} 件あります。Timeline の「Claude に頼む → テロップを書いてもらう」で、人格の文体・フックの型・締めの語で埋めます（自分で書いても可）`
            : 'Timeline の「Claude に頼む → テロップを書いてもらう」で、人格の文体で埋めます'
          : '台本のテロップがそのまま入ります。Timeline で文字数（13 文字）・改行・位置を確認します',
      action: {label: 'Timeline へ', tab: 'timeline'},
    },
    {
      id: 'narration',
      label: 'ナレーション原稿',
      done: narr > 0,
      detail:
        route === 'plan'
          ? 'Timeline の「Claude に頼む → ナレーション原稿」か、Render の「仕上げ」で作ります。テロップに沿った原稿を人格の文体で書き、尺に合わせます'
          : '台本のナレーションがそのまま入っています（無い区間があれば Render の「仕上げ」で原稿を足します）',
      action: {label: 'Timeline へ', tab: 'timeline'},
    },
    {
      id: 'finish',
      label: '音声・レンダー・キャプション・納品',
      done: snap.finalOut,
      detail: 'Render の「仕上げ」で、人格のボイスで音声を作り → レンダー → 合成 → キャプション（人格のキャプションの型）→ outputs/ に納品まで一気に進みます',
      action: {label: 'Render へ', tab: 'render'},
    },
  ];
  let nowSeen = false;
  return raw.map(({done, ...r}) => {
    let status: FlowStatus = done ? 'done' : 'todo';
    if (!done && !nowSeen) {
      status = 'now';
      nowSeen = true;
    }
    return {...r, status};
  });
};

/** 人格がどの工程に効くか（画面の説明用） */
export const personaEffects = (p: Persona): string[] => {
  const out = [
    `文体「${p.tone || '（未設定）'}」→ テロップ・ナレーション・キャプションの言い回し`,
    `締め「${p.cta[0]}」→ 最後のテロップ（${p.ctaPatterns.join('／')} を含まないと検証で指摘）`,
    p.hookStyle === 'areaDigit' ? '冒頭フック → 「エリア名＋一桁数字」の型（エリア名はバッジに出す）' : '冒頭フック → 型は縛らない',
    `既定の型 ${p.defaultFormat} ${FORMAT_SPECS[p.defaultFormat].name} → 「プラン（型に流し込む）」の並び`,
  ];
  if (p.narrationRules.length) out.push(`ナレーションの禁則 ${p.narrationRules.length} 条 → 原稿の言い回し`);
  out.push(p.captionGuide.trim() || p.skillDir ? 'キャプションの型 → Render の「AI にキャプションを書いてもらう」' : 'キャプションの型が空 → 汎用の型で書く（Settings の「人格」で足せます）');
  out.push(p.narration.voiceId ? `ボイス「${p.narration.voiceTitle || p.narration.voiceId}」→ Render の音声生成` : 'ボイス未設定 → 音声生成が止まります（Settings の「人格」で入れてください）');
  return out;
};
