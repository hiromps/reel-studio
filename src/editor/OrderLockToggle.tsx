import React from 'react';

/** カットの手動操作とは独立した、自動変更に対する並び順のロック。保存すると案件に残る。 */
export const OrderLockToggle: React.FC<{locked: boolean; onChange: (locked: boolean) => void}> = ({locked, onChange}) => (
  <label className="sb-inline" title="AI や自動尺合わせによる並べ替え・素材の入れ替え・カットの追加・削除を防ぎます。手動編集は自由です。変更後は保存（Ctrl+S）してください">
    <input type="checkbox" checked={locked} onChange={(e) => onChange(e.target.checked)} />
    並び順をロック
  </label>
);
