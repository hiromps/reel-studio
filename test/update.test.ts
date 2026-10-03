// 更新のポップアップと、画面からの再起動の取り決め。
// ここが崩れると「更新があるのに知らせない／何度も出る」「サーバーが落ちたまま誰も起こさない」になる。
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {appRoot, defaultSettings, mergeSettings} from '../core/settings';
import {SettingsPatchSchema} from '../shared/schema/settings';
import {RESTART_EXIT_CODE, restartBlocker, shouldPromptUpdate, UPDATE_SNOOZE_MS, type UpdatePromptInput} from '../shared/update';

const base: UpdatePromptInput = {notify: 'popup', isGit: true, behind: 3, latestCommit: 'b'.repeat(40), snooze: null, now: 1_000_000};

describe('ポップアップを出すか（shouldPromptUpdate）', () => {
  it('ポップアップにしていて、遅れていれば出す', () => {
    expect(shouldPromptUpdate(base)).toBe(true);
  });

  it('手動にしている・zip で入れた・最新・分からないときは出さない', () => {
    expect(shouldPromptUpdate({...base, notify: 'manual'})).toBe(false);
    expect(shouldPromptUpdate({...base, isGit: false})).toBe(false);
    expect(shouldPromptUpdate({...base, behind: 0})).toBe(false);
    expect(shouldPromptUpdate({...base, behind: null})).toBe(false);
    expect(shouldPromptUpdate({...base, latestCommit: null})).toBe(false);
  });

  it('「あとで」を押した版は期限まで出さず、期限が過ぎたら出す', () => {
    const snooze = {commit: base.latestCommit!, until: base.now + UPDATE_SNOOZE_MS};
    expect(shouldPromptUpdate({...base, snooze})).toBe(false);
    expect(shouldPromptUpdate({...base, snooze, now: snooze.until})).toBe(true);
  });

  it('「あとで」のあとにもっと新しい版が出たら、期限内でもすぐ出す', () => {
    const snooze = {commit: 'a'.repeat(40), until: base.now + UPDATE_SNOOZE_MS};
    expect(shouldPromptUpdate({...base, snooze})).toBe(true);
  });
});

describe('自動で起動し直せるか（restartBlocker）', () => {
  it('ランチャー経由でジョブが無ければ起動し直せる', () => {
    expect(restartBlocker({launcher: true, runningJobs: 0})).toBeNull();
  });
  it('ジョブ実行中は断る（作業を途中で切らない）', () => {
    expect(restartBlocker({launcher: true, runningJobs: 2})).toMatch(/2 件/);
  });
  it('ランチャー経由でなければ断る（落としたまま誰も起こさない）', () => {
    expect(restartBlocker({launcher: false, runningJobs: 0})).toMatch(/手で再起動/);
  });
});

describe('ランチャーとの取り決め', () => {
  const launcher = fs.readFileSync(path.join(appRoot, 'scripts', 'launch.mjs'), 'utf8');
  it('再起動の終了コードがランチャーと一致している', () => {
    expect(launcher).toContain(`const RESTART_EXIT_CODE = ${RESTART_EXIT_CODE};`);
  });
  it('ランチャーはサーバーに目印（REEL_STUDIO_LAUNCHER）を渡す', () => {
    expect(launcher).toContain("REEL_STUDIO_LAUNCHER: '1'");
  });
});

describe('設定（update.notify）', () => {
  it('既定はポップアップで知らせる', () => {
    expect(defaultSettings().update.notify).toBe('popup');
  });
  it('手動に切り替えられ、ほかの設定には触らない', () => {
    const cur = mergeSettings(defaultSettings(), {agent: {model: 'sonnet'}});
    const next = mergeSettings(cur, {update: {notify: 'manual'}});
    expect(next.update.notify).toBe('manual');
    expect(next.agent.model).toBe('sonnet');
    // update を含まない保存では変わらない
    expect(mergeSettings(next, {agent: {model: 'opus'}}).update.notify).toBe('manual');
  });
  it('知らない値は受け付けない', () => {
    expect(SettingsPatchSchema.safeParse({update: {notify: 'auto'}}).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({update: {notify: 'popup'}}).success).toBe(true);
  });
});
