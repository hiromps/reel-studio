import React, {useEffect, useMemo, useRef, useState} from 'react';
import {SCRIPT_SKILL_MAX_BYTES, ScriptSkillSchema, sameScriptSkill, scriptSkillCatalog, scriptSkillInfo, skillWithoutId, type ScriptSkill, type ScriptSkillEntry} from '@shared/script-skill';
import type {SettingsPatch} from '@shared/schema/settings';

export const ScriptSkillCard: React.FC<{
  skill?: ScriptSkill;
  skills?: ScriptSkillEntry[];
  save: (patch: SettingsPatch, done: string) => Promise<boolean>;
}> = ({skill, skills, save}) => {
  const entries = useMemo(() => scriptSkillCatalog({scriptSkill: skill, scriptSkills: skills}).entries, [skill, skills]);
  const [selectedId, setSelectedId] = useState(entries[0]?.id ?? '');
  const [candidate, setCandidate] = useState<ScriptSkill | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useEffect(() => {if (!entries.some((s) => s.id === selectedId)) setSelectedId(entries[0]?.id ?? '');}, [entries, selectedId]);
  const selected = entries.find((s) => s.id === selectedId);
  const shown = candidate ?? selected;
  const info = shown ? scriptSkillInfo(shown.content) : null;

  const read = async (file: File) => {
    setBusy(true); setError(null); setStatus('ファイルを読み込んでいます…');
    try {
      if (!/\.md$/i.test(file.name)) throw new Error('Markdown（.md）ファイルを選んでください');
      if (file.size > SCRIPT_SKILL_MAX_BYTES) throw new Error('ファイルは128 KB以下にしてください');
      const parsed = ScriptSkillSchema.safeParse({fileName: file.name, content: await file.text(), enabled: true});
      if (!parsed.success) throw new Error(parsed.error.issues[0].message);
      if (mounted.current) {setCandidate(parsed.data); setStatus('内容を確認して保存してください');}
    } catch (e) {
      if (mounted.current) {setError((e as Error).message); setStatus('');}
    } finally {
      if (mounted.current) {setBusy(false); if (input.current) input.current.value = '';}
    }
  };

  const persist = async (patch: SettingsPatch, done: string, nextId?: string) => {
    setBusy(true); setError(null); setStatus('保存しています…');
    try {
      if (await save(patch, done)) {
        if (mounted.current) {setCandidate(null); setStatus(done); if (nextId) setSelectedId(nextId);}
      } else if (mounted.current) {setError('保存できませんでした。もう一度保存してください'); setStatus('');}
    } catch (e) {
      if (mounted.current) {setError((e as Error).message); setStatus('');}
    } finally {if (mounted.current) setBusy(false);}
  };

  const add = () => {
    if (!candidate) return;
    if (entries.length >= 20) {setError('登録できる台本スキルは20件までです'); return;}
    const entry = {...candidate, id: crypto.randomUUID()};
    void persist({scriptSkills: [...entries, entry], ...(!skill && !entries.length ? {scriptSkill: skillWithoutId(entry)} : {})}, '台本スキルを追加しました', entry.id);
  };
  const replace = () => {
    if (!candidate || !selected) return;
    const next = {...candidate, id: selected.id};
    void persist({scriptSkills: entries.map((e) => e.id === selected.id ? next : e), ...(sameScriptSkill(selected, skill) ? {scriptSkill: skillWithoutId(next)} : {})}, 'スキルを置き換えました。案件に保存済みの内容は保持されます', next.id);
  };
  const toggle = () => {
    if (!selected) return;
    const next = {...selected, enabled: !selected.enabled};
    void persist({scriptSkills: entries.map((e) => e.id === next.id ? next : e), ...(sameScriptSkill(selected, skill) ? {scriptSkill: skillWithoutId(next)} : {})}, next.enabled ? '台本スキルを有効にしました' : '新しく選ぶ候補から外しました。案件の選択は保持されます');
  };
  const remove = () => selected && void persist({scriptSkills: entries.filter((e) => e.id !== selected.id), ...(sameScriptSkill(selected, skill) ? {scriptSkill: null} : {})}, 'スキルを削除しました。案件に保存済みの内容は保持されます');

  return <section className="card skill-library" aria-labelledby="script-skill-title" aria-busy={busy}>
    <div className="settings-card-heading"><span className="settings-step" aria-hidden="true">2</span><div><h2 id="script-skill-title">AIの台本スキル</h2><p>好みの書き方を登録して、案件ごとに選べます。</p></div><span className="pill">{entries.length}件</span></div>
    <div className="form">
      <div className="full"><span>台本スキルを追加</span><div className="btns skill-upload">
        <button type="button" disabled={busy} aria-describedby="script-skill-help" onClick={() => input.current?.click()}>SKILL.mdを選ぶ</button>
        <span>{candidate?.fileName ?? 'ファイルはまだ選ばれていません'}</span>
        <input ref={input} type="file" accept=".md,text/markdown" hidden aria-label="台本スキルのファイル" disabled={busy} onChange={(e) => {const file = e.target.files?.[0]; if (file) void read(file);}} />
      </div></div>
      <p id="script-skill-help" className="hint full">SKILL.mdなどのMarkdown（UTF-8・128 KBまで）。登録後は「AIで台本」の画面で選択できます。</p>
      {entries.length > 0 && <label className="full">登録済みのスキル
        <select value={selectedId} disabled={busy || !!candidate} onChange={(e) => {setSelectedId(e.target.value); setError(null); setStatus('');}}>
          {entries.map((e) => <option key={e.id} value={e.id}>{scriptSkillInfo(e.content).name}{!e.enabled ? '（無効）' : ''}{sameScriptSkill(e, skill) && skill?.enabled ? '（既定）' : ''}</option>)}
        </select>
      </label>}
      {shown && info && <div className="full skill-preview">
        <strong>{info.name}</strong> {candidate && <span className="pill warn">未保存</span>}
        {info.description && <p>{info.description}</p>}
        <details open={candidate ? true : undefined}><summary>内容を確認する <span className="hint">{shown.fileName}</span></summary><label>読み込んだ内容<textarea value={shown.content} readOnly rows={8} spellCheck={false} /></label><p className="hint">referencesなど、別ファイルへのリンク先は取り込まれません。</p></details>
      </div>}
    </div>
    <div className="btns">
      {candidate ? <>
        <button className="primary" disabled={busy || entries.length >= 20} onClick={add}>このスキルを追加</button>
        <button disabled={busy} onClick={() => {setCandidate(null); setError(null); setStatus('読み込みを取り消しました');}}>取り消す</button>
        {selected && <button disabled={busy} onClick={replace}>選択中のスキルと置き換える</button>}
      </> : selected ? <>
        <button disabled={busy || !selected.enabled || sameScriptSkill(selected, skill) && !!skill?.enabled} onClick={() => void persist({scriptSkills: entries, scriptSkill: skillWithoutId(selected)}, '未指定の案件で使う既定スキルを変更しました')}>未指定の案件の既定にする</button>
        <details className="skill-manage"><summary>管理</summary><div className="btns"><button disabled={busy} onClick={toggle}>{selected.enabled ? '無効にする' : '有効にする'}</button><button className="danger" disabled={busy} onClick={remove}>スキルを削除</button></div></details>
      </> : <p className="hint">台本スキルは未設定です。スキルなしでもAIで台本を作れます。</p>}
    </div>
    {skill?.enabled && <p className="hint">未指定の案件の既定：{scriptSkillInfo(skill.content).name} <button className="small" disabled={busy} onClick={() => void persist({scriptSkill: null, scriptSkills: entries}, '未指定の案件ではスキルを使わない設定にしました')}>既定を解除</button></p>}
    {error && <p className="warn-text" role="alert">{error}</p>}
    <p className="hint" role="status">{status}</p>
  </section>;
};
