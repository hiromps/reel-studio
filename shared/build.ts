// 「仕上げ」パイプライン（原稿 → 音声 → レンダー → 合成 → 納品）の段取り。純粋（ファイルも AI も触らない）。
//
// 台本や構成ができたあと、完成動画までは 5〜6 個のボタンを順番に押す必要があった。
// 案件の状態（何が済んでいて何が古いか）から「これから走らせる工程」を決め、1 つのジョブとして
// 順に実行できるようにする。判断に使う事実は core/build.ts が fs から集めて BuildFacts にする。

export const BUILD_STEP_IDS = ['caption', 'narration', 'tts', 'render', 'mix', 'deliver'] as const;
export type BuildStepId = (typeof BUILD_STEP_IDS)[number];

export type BuildFacts = {
  hasCuts: boolean;
  cutCount: number;
  /** {{gNN:intent}} のまま残っているテロップ */
  placeholders: number;
  /** validate の E（allowErrors で無視できるもの）。致命的なもの（素材が無い等）は fatal に */
  validationErrors: number;
  fatalErrors: number;
  hasNarration: boolean;
  segments: number;
  /** 音声が未生成（needsTts か wav が無い）のブロック数 */
  needsTts: number;
  /** out/final.mp4 がある */
  hasFinal: boolean;
  /** cuts.json か使っている素材の方が out/final.mp4 より新しい（レンダーし直しが要る） */
  finalStale: boolean;
  /** 古い理由。cuts = cuts.json を直した / media = 素材の中身が変わった（顔モザイク等） */
  finalStaleBy?: 'cuts' | 'media';
  /** out/final_narration.mp4 がある */
  hasMixed: boolean;
  /** mix のやり直しが要る理由（core/deliver.ts の narrationReady）。無ければ最新 */
  mixStaleReason?: string;
  hasCaption: boolean;
  /** FISH_API_KEY が見つかる */
  ttsAvailable: boolean;
  /** claude CLI が見つかる */
  claudeAvailable: boolean;
};

export type BuildStepStatus = 'done' | 'todo' | 'blocked';

export type BuildStep = {
  id: BuildStepId;
  label: string;
  /** done = 最新のものがある / todo = 走らせる必要がある / blocked = 前提が足りず走らせられない */
  status: BuildStepStatus;
  /** 状態の説明（1 行） */
  detail: string;
  /** 裏で claude を起動する（課金される） */
  ai: boolean;
  /** 既定でチェックを入れるか */
  defaultOn: boolean;
};

export const BUILD_STEP_LABEL: Record<BuildStepId, string> = {
  caption: 'キャプションを書く（AI）',
  narration: 'ナレーション原稿を書く（AI）',
  tts: '音声を生成する（Fish Audio）',
  render: '本番レンダー（Remotion）',
  mix: 'ナレーション合成（mix）',
  deliver: '納品（outputs/ へ）',
};

/**
 * 案件の状態から各工程の状態を決める。
 * 順番は実行順（キャプションは原稿の材料になるので原稿より先）。
 */
export const planBuild = (f: BuildFacts): BuildStep[] => {
  const steps: BuildStep[] = [];
  const noCuts = !f.hasCuts || f.cutCount === 0;

  // caption：無ければ AI で書く（任意）。原稿の肉付け材料になるので先に置く
  steps.push({
    id: 'caption',
    label: BUILD_STEP_LABEL.caption,
    status: f.hasCaption ? 'done' : noCuts ? 'blocked' : !f.claudeAvailable ? 'blocked' : 'todo',
    detail: f.hasCaption ? 'caption.txt があります' : noCuts ? 'カット構成がまだありません' : !f.claudeAvailable ? 'claude CLI が見つかりません' : '店舗情報を裏取りして caption.txt を書きます',
    ai: true,
    defaultOn: !f.hasCaption,
  });

  // narration
  const narrationDone = f.hasNarration && f.segments > 0;
  const narrationBlocked = noCuts || f.placeholders > 0 || !f.claudeAvailable;
  steps.push({
    id: 'narration',
    label: BUILD_STEP_LABEL.narration,
    status: narrationDone ? 'done' : narrationBlocked ? 'blocked' : 'todo',
    detail: narrationDone
      ? `${f.segments} ブロックの原稿があります`
      : noCuts
        ? 'カット構成がまだありません'
        : f.placeholders > 0
          ? `テロップが ${f.placeholders} 件未記入です（先に Timeline で埋めてください）`
          : !f.claudeAvailable
            ? 'claude CLI が見つかりません'
            : 'テロップと映像を見て narration.json を書きます',
    ai: true,
    defaultOn: !narrationDone,
  });

  // tts：原稿ができる前提で「走らせる」にできる（原稿が todo なら続けて走る）
  const ttsDone = narrationDone && f.needsTts === 0;
  const ttsBlocked = !f.ttsAvailable || (!narrationDone && narrationBlocked);
  steps.push({
    id: 'tts',
    label: BUILD_STEP_LABEL.tts,
    status: ttsDone ? 'done' : ttsBlocked ? 'blocked' : 'todo',
    detail: ttsDone ? '全ブロックに音声があります' : !f.ttsAvailable ? 'FISH_API_KEY が見つかりません' : narrationDone ? `${f.needsTts} ブロックの音声を作ります` : '原稿ができたあとに全ブロックの音声を作ります',
    ai: false,
    defaultOn: !ttsDone,
  });

  // render
  const renderDone = f.hasFinal && !f.finalStale;
  const renderBlocked = noCuts || f.fatalErrors > 0;
  steps.push({
    id: 'render',
    label: BUILD_STEP_LABEL.render,
    status: renderDone ? 'done' : renderBlocked ? 'blocked' : 'todo',
    detail: renderDone
      ? 'out/final.mp4 は cuts.json より新しいです'
      : noCuts
        ? 'カット構成がまだありません'
        : f.fatalErrors > 0
          ? `素材が無い等、レンダーできない指摘が ${f.fatalErrors} 件あります`
          : f.hasFinal
            ? f.finalStaleBy === 'media'
              ? '素材を差し替えた（顔モザイク等）あとレンダーしていません'
              : 'cuts.json を直したあとレンダーしていません'
            : f.placeholders > 0
              ? `テロップが ${f.placeholders} 件未記入です（そのまま出すか、先に埋めてください）`
              : f.validationErrors > 0
                ? `検証の E が ${f.validationErrors} 件あります（「指摘を承知で」なら通ります）`
                : 'out/final.mp4 を書き出します',
    ai: false,
    defaultOn: !renderDone,
  });

  // mix：レンダーと音声が揃う前提
  const mixDone = f.hasMixed && !f.mixStaleReason && renderDone && ttsDone;
  const mixBlocked = renderBlocked || ttsBlocked;
  steps.push({
    id: 'mix',
    label: BUILD_STEP_LABEL.mix,
    status: mixDone ? 'done' : mixBlocked ? 'blocked' : 'todo',
    detail: mixDone ? 'out/final_narration.mp4 は最新です' : f.mixStaleReason && f.hasMixed ? f.mixStaleReason : 'レンダーと音声を混ぜて out/final_narration.mp4 を作ります',
    ai: false,
    defaultOn: !mixDone,
  });

  // deliver：常に「走らせる」候補（同じ中身なら何もしないので安全）
  steps.push({
    id: 'deliver',
    label: BUILD_STEP_LABEL.deliver,
    status: mixBlocked ? 'blocked' : 'todo',
    detail: mixBlocked ? '完成品ができないので納品できません' : '完成品だけを outputs/ にコピーします（同じ中身なら何もしません）',
    ai: false,
    defaultOn: true,
  });

  return steps;
};

/** 既定で走らせる工程（todo かつ defaultOn）。実行順のまま返す */
export const defaultBuildSelection = (steps: readonly BuildStep[]): BuildStepId[] => steps.filter((s) => s.status === 'todo' && s.defaultOn).map((s) => s.id);

/**
 * 選択の整合性を見る。後ろの工程を選んでいるのに、その前提になる工程が「未完了なのに選ばれていない」なら理由を返す。
 * 例：mix を選んだのに render が todo で未選択。
 */
export const buildSelectionIssues = (steps: readonly BuildStep[], selected: readonly BuildStepId[]): string[] => {
  const sel = new Set(selected);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const out: string[] = [];
  const need = (id: BuildStepId, deps: BuildStepId[]) => {
    if (!sel.has(id)) return;
    for (const d of deps) {
      const s = byId.get(d);
      if (!s) continue;
      if (s.status === 'blocked') out.push(`「${BUILD_STEP_LABEL[id]}」には「${BUILD_STEP_LABEL[d]}」が要りますが、${s.detail}`);
      else if (s.status === 'todo' && !sel.has(d)) out.push(`「${BUILD_STEP_LABEL[id]}」の前に「${BUILD_STEP_LABEL[d]}」が要りますが、選ばれていません`);
    }
  };
  need('tts', ['narration']);
  need('mix', ['render', 'tts']);
  need('deliver', ['mix']);
  for (const id of selected) {
    const s = byId.get(id);
    if (s?.status === 'blocked') out.push(`「${s.label}」は走らせられません：${s.detail}`);
  }
  return [...new Set(out)];
};

/** 実行順に並べ直す（選択の順序に依存しない） */
export const orderBuildSteps = (selected: readonly BuildStepId[]): BuildStepId[] => BUILD_STEP_IDS.filter((id) => selected.includes(id));
