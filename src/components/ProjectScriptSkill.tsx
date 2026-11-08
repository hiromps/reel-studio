import React from 'react';
import {useStudio} from '../state/store';
import {sameScriptSkill, scriptSkillInfo, scriptSkillLabels} from '@shared/script-skill';

export const ScriptSkillStatus: React.FC = () => {
  const s = useStudio();
  const selection = s.files.brief.data?.scriptSkill;
  const skill = selection === undefined ? s.config?.scriptSkills?.defaultSkill : selection;
  const label = skill?.enabled ? scriptSkillInfo(skill.content).name : '使わない';
  return <p className="skill-status">使用スキル：<strong>{label}</strong>{selection === undefined ? '（設定の既定）' : selection ? '（この案件で選択）' : '（この案件）'}{s.files.brief.dirty && <span className="pill warn">案件設定が未保存</span>}</p>;
};

export const ProjectScriptSkill: React.FC = () => {
  const s = useStudio();
  const brief = s.files.brief.data;
  if (!brief) return null;
  const catalog = s.config?.scriptSkills;
  const entries = catalog?.entries ?? [];
  const selected = brief.scriptSkill;
  const current = selected ? entries.find((e) => e.id === selected.id && e.enabled && sameScriptSkill(e, selected)) : undefined;
  const value = selected === undefined ? '__default' : selected === null ? '__none' : current?.id ?? '__snapshot';
  const labels = scriptSkillLabels(entries);
  const activeJobs = s.jobs.some((j) => j.slug === s.active && ['running', 'queued'].includes(j.status));
  return <section className="card project-skill-card" aria-labelledby="project-skill-title">
    <div><h2 id="project-skill-title">この案件で使う台本スキル</h2><p>AIにどんな書き方で作ってほしいかを選びます。</p></div>
    <label>台本スキル
      <select value={value} disabled={activeJobs || !s.config} onChange={(e) => {
        const key = e.target.value;
        const entry = entries.find((item) => item.id === key && item.enabled);
        if (key === '__default' || key === '__none' || entry) s.setFile('brief', {...brief, scriptSkill: key === '__default' ? undefined : key === '__none' ? null : {...entry!}});
      }}>
        <option value="__default">設定の既定を使う{catalog?.defaultSkill?.enabled ? `：${scriptSkillInfo(catalog.defaultSkill.content).name}` : '（スキルなし）'}</option>
        <option value="__none">この案件では使わない</option>
        {value === '__snapshot' && selected && <option value="__snapshot">{scriptSkillInfo(selected.content).name}（案件に保存済み）</option>}
        {entries.filter((entry) => entry.enabled).map((entry) => <option key={entry.id} value={entry.id}>{labels.get(entry.id)}</option>)}
      </select>
    </label>
    <ScriptSkillStatus />
    <p className="hint">AIでの台本作成と、保存した動画の型からの台本作成に使います。選んだ内容は案件に保存され、登録元の変更・削除で変わりません。追加は「設定 → AIの台本スキル」から。</p>
    {selected && <details><summary>選んだスキルの内容</summary><pre className="skill-content">{selected.content}</pre></details>}
    <div className="btns"><button disabled={!s.files.brief.dirty || activeJobs} onClick={() => void s.saveFile('brief')}>この案件の設定を保存</button></div>
  </section>;
};
