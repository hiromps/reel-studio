import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import {StudioProvider} from './state/store';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StudioProvider>
      <App />
    </StudioProvider>
  </React.StrictMode>,
);
