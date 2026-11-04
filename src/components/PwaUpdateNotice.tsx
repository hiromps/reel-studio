import React, {useSyncExternalStore, useState} from 'react';
import {hasPwaUpdate, onPwaUpdate} from '../pwa';

export const PwaUpdateNotice: React.FC<{hasUnsavedChanges?: boolean}> = ({hasUnsavedChanges = false}) => {
  const available = useSyncExternalStore(onPwaUpdate, hasPwaUpdate, () => false);
  const [dismissed, setDismissed] = useState(false);
  if (!available || dismissed) return null;
  return <aside className="pwa-update" role="status" aria-label="PWAの更新">
    <strong>最新版を利用できます</strong>
    <p>{hasUnsavedChanges ? '変更を保存すると、最新版に更新できます。' : '編集中の内容を保存してから、再読み込みしてください。'}</p>
    <div className="btns">
      <button className="primary" disabled={hasUnsavedChanges} onClick={() => window.location.reload()}>再読み込みして更新</button>
      <button onClick={() => setDismissed(true)}>あとで</button>
    </div>
  </aside>;
};
