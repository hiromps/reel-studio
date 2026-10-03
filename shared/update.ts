// 更新のポップアップと自動再起動の取り決め（画面・サーバー・テストで共有。fs に依存しない）。
//
// 流れ: 画面が「更新する」→ サーバーが git pull → 画面が再起動を頼む → サーバーが RESTART_EXIT_CODE で終わる
// → ランチャー（scripts/launch.mjs）が新しいランチャーを起動し直す（依存の導入・ビルド・起動はそちらが行う）
// → 画面は新しい版のサーバーが応答したら読み直す。
import type {UpdateNotify} from './schema/settings';

/**
 * サーバーが「更新したので起動し直してほしい」とランチャーに伝える終了コード。
 * scripts/launch.mjs にも同じ値がある（.mjs から TS を読めないため。test/update.test.ts で一致を確かめる）
 */
export const RESTART_EXIT_CODE = 75;

/** ランチャーがサーバーに渡す目印。これが無い（npm run server など）ときは自動で起動し直せない */
export const LAUNCHER_ENV = 'REEL_STUDIO_LAUNCHER';

/** 「あとで」を押したら、この時間は同じ版で知らせない */
export const UPDATE_SNOOZE_MS = 24 * 60 * 60_000;

/** 画面が版を確かめ直す間隔（サーバー側でも 30 分覚えているので GitHub への問い合わせは増えない） */
export const UPDATE_POLL_MS = 60 * 60_000;

/** 「あとで」の記録（ブラウザの localStorage に置く） */
export type UpdateSnooze = {commit: string; until: number};

export type UpdatePromptInput = {
  notify: UpdateNotify;
  isGit: boolean;
  behind: number | null;
  latestCommit: string | null;
  snooze: UpdateSnooze | null;
  now: number;
};

/**
 * ポップアップを出すか。
 * - 手動にしている／zip で入れた（更新できない）／遅れていない・分からないときは出さない
 * - 「あとで」を押した版は期限まで出さない。もっと新しい版が出たらすぐ出す
 */
export const shouldPromptUpdate = (i: UpdatePromptInput): boolean => {
  if (i.notify !== 'popup' || !i.isGit) return false;
  if (i.behind === null || i.behind <= 0 || !i.latestCommit) return false;
  if (i.snooze && i.snooze.commit === i.latestCommit && i.now < i.snooze.until) return false;
  return true;
};

/** 自動で再起動できない理由（できるなら null）。画面はこれをそのまま出す */
export const restartBlocker = (s: {launcher: boolean; runningJobs: number}): string | null => {
  if (s.runningJobs > 0) return `実行中のジョブが ${s.runningJobs} 件あります。終わってから更新してください`;
  if (!s.launcher)
    return 'ランチャー（Reel Studio.cmd・npm start）から起動していないため、自動では起動し直せません。更新のあと、手で再起動してください';
  return null;
};
