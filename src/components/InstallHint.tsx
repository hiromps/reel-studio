// iOS で「ホーム画面に追加」を一度だけ案内する。
// iOS の Safari はインストールを自動で勧めないので、ここで出さないと PWA として使ってもらえない
// （追加して開くと、アドレスバーが消えて全画面になり、通知も受け取れるようになる）。
import React, {useState} from 'react';
import {canPromptIosInstall} from '../pwa';
import {useStringPref} from '../hooks/usePref';

export const InstallHint: React.FC = () => {
  const [dismissed, setDismissed] = useStringPref('reel-studio.installHint', '');
  const [show] = useState(() => canPromptIosInstall());
  if (!show || dismissed === '1') return null;
  return (
    <div className="installhint">
      <span>
        ホーム画面に追加すると全画面のアプリとして開けます —— 下の <b>共有</b> ボタン → <b>ホーム画面に追加</b>
      </span>
      <button className="small" onClick={() => setDismissed('1')}>
        閉じる
      </button>
    </div>
  );
};
