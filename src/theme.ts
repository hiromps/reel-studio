// 画面の配色（ライト／ダーク）。既定はライト。右上の月のボタンで切り替え、ブラウザに記憶する。
// 描画より前に html[data-theme] を付けておく（main.tsx から呼ぶ）と、ダークの人でも白く光らない
import {readPref, writePref} from './hooks/usePref';

export type Theme = 'light' | 'dark';

const KEY = 'reel-studio.theme';
/** アドレスバー・ステータスバーの色。styles.css の --bg と揃える */
const BAR_COLOR: Record<Theme, string> = {light: '#eef0f4', dark: '#0f1114'};

export const readTheme = (): Theme => (readPref<string>(KEY, 'light', (r) => r) === 'dark' ? 'dark' : 'light');

export const applyTheme = (t: Theme) => {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR_COLOR[t]);
};

export const saveTheme = (t: Theme) => {
  writePref(KEY, t);
  applyTheme(t);
};
