// Brief の「作り方の流れ」カード。6 つの工程の済み／いま／これからと、構成の作り方（3 つのうち 1 つ）の選択。
// 判定は briefSteps.ts（純粋・テストあり）。ここは表示だけ。
import React from 'react';
import type {Persona} from '@shared/personas';
import {personaEffects, ROUTE_INFO, ROUTE_ORDER, type BriefRoute, type FlowStep} from './briefSteps';
import type {StepTab} from './nextStep';

export const BriefFlow: React.FC<{
  steps: FlowStep[];
  route: BriefRoute;
  recommended: BriefRoute;
  onRoute: (r: BriefRoute) => void;
  persona: Persona | null;
  onTab: (t: StepTab) => void;
  /** 同じ画面のカードへスクロール（data-tour 値） */
  scrollTo: (tour: string) => void;
}> = ({steps, route, recommended, onRoute, persona, onTab, scrollTo}) => {
  const go = (st: FlowStep) => {
    if (!st.action) return;
    if (st.action.tab !== 'brief') return onTab(st.action.tab);
    if (st.action.tour) scrollTo(st.action.tour);
  };
  const now = steps.find((s) => s.status === 'now');
  return (
    <section className="card" data-tour="brief-flow">
      <div className="row">
        <h2 style={{margin: 0}}>作り方の流れ</h2>
        <span className="hint">上から順に進めれば、人格の文体で揃った 1 本ができます。色が付いている工程がいまやることです</span>
      </div>
      <ol className="flow-steps">
        {steps.map((st, i) => (
          <li key={st.id} className={`flow-step ${st.status}`}>
            <span className="flow-mark" aria-hidden="true">
              {st.status === 'done' ? '✓' : i + 1}
            </span>
            <div className="flow-body">
              <b>{st.label}</b>
              <p className="hint">{st.detail}</p>
            </div>
            {st.action && st.status !== 'done' && (
              <button className={st.status === 'now' ? 'primary small' : 'small'} onClick={() => go(st)}>
                {st.action.label}
              </button>
            )}
          </li>
        ))}
      </ol>

      <h3>構成の作り方（どれか 1 つ。選んだものがすぐ下に出ます）</h3>
      <div className="flow-routes">
        {ROUTE_ORDER.map((id) => {
          const r = ROUTE_INFO[id];
          const on = route === id;
          return (
            <button key={id} type="button" className={`flow-route${on ? ' on' : ''}`} onClick={() => onRoute(id)} aria-pressed={on}>
              <span className="flow-route-head">
                <b>{r.title}</b>
                {on && <span className="flow-primary-tag">いまの作り方</span>}
                {!on && recommended === id && <span className="pill ok">おすすめ</span>}
              </span>
              <span className="hint">こんなとき: {r.when}</span>
              <span className="hint">できるもの: {r.makes}</span>
              <span className="hint">そのあと: {r.then}</span>
            </button>
          );
        })}
      </div>
      {now?.id === 'build' && (
        <p className="hint">
          3 つは<b>どれか 1 つ</b>を使います（どれも cuts.json を書くので、混ぜると上書きし合います）。テロップとナレーションを同じ台本から作る「台本から組み立てる」「バズ動画の型を写す」の方が、1 本の中の言い回しが揃いやすいです。
        </p>
      )}

      {persona && (
        <details>
          <summary className="hint">人格「{persona.label}」がどこに効くか</summary>
          <ul className="flow-persona hint">
            {personaEffects(persona).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <p className="hint">人格の中身（文体・締め・フックの型・キャプションの型・ボイス）は Settings の「人格」で変えられます。変えたあとに作ったテロップ・原稿・キャプションから効きます</p>
        </details>
      )}
    </section>
  );
};
