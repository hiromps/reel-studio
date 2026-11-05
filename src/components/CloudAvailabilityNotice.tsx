import React from 'react';
export const CloudAvailabilityNotice: React.FC<{worker?: {online: boolean; lastSeen: string | null}; onHide: () => void}> = ({worker, onHide}) => <div className="cloud-availability" aria-label="利用できる機能の案内">
  <div><b>PCなしで使えます</b><p>Modalの素材追加・軽量プレビュー・編集・クラウド書き出しを利用できます。</p>
    <details><summary>PCを使う機能と接続状態</summary><p>AI台本・新しい音声生成・PCでの書き出しは、PCでReel Studioを起動して利用します。PCは{worker?.online ? '接続中' : '未接続'}です。</p>
      {worker?.lastSeen && <p>PCの最終応答: {new Date(worker.lastSeen).toLocaleString('ja-JP')}</p>}
    </details>
  </div>
  <button aria-label="利用できる機能の案内を非表示" title="使い方から再表示できます" onClick={onHide}>×</button>
</div>;
