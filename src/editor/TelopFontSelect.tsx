import React, {useState} from 'react';
import {useStudio} from '../state/store';

/** 選択中のカットやグループによらず、動画全体のテロップフォントを変更する。 */
export const TelopFontSelect: React.FC<{font?: string; onChange: (font: string | undefined) => void}> = ({font, onChange}) => {
  const s = useStudio();
  const fonts = s.config?.fonts ?? [];
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try { await s.reloadConfig(); }
    catch (e) { s.toast('フォント一覧の更新に失敗: ' + (e as Error).message, 'error'); }
    finally { setRefreshing(false); }
  };
  return (
    <div style={{minWidth: 0, width: '100%'}}>
      <label title="動画内のすべてのテロップに適用します。Settingsで取り込んだフォントから選べます">
        テロップのフォント（動画全体）
        <select aria-label="テロップのフォント（動画全体）" value={font ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">同梱の明朝（Noto Serif JP）</option>
          {fonts.map((f) => <option key={f.file} value={f.file}>{f.label}</option>)}
          {font && !fonts.some((f) => f.file === font) && <option value={font}>{font}（置き場に無い）</option>}
        </select>
      </label>
      <div className="row" style={{marginTop: 4}}>
        <span className="hint grow">{fonts.length ? '変更はプレビューに反映。保存（Ctrl+S）で確定します。' : '別のフォントは Settings → テロップのフォントで取り込めます。'}</span>
        <button className="small" onClick={() => void refresh()} disabled={refreshing} title="編集内容を保ったまま、取り込み済みフォントの一覧だけを更新します">{refreshing ? '更新中…' : '一覧を更新'}</button>
      </div>
    </div>
  );
};
