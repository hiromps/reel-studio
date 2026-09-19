import React from 'react';
import {createRoot} from 'react-dom/client';
import {Gate} from './Gate';
import {registerServiceWorker} from './pwa';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Gate />
  </React.StrictMode>,
);

// PWA（ホーム画面に追加して使う）。ローカルの開発中は登録しない
registerServiceWorker();
