// 更新の判定まわり。fork して使う人がいるので、配布元は origin から読む。
// ここを間違えると「他人のリポジトリの更新」を案内してしまう。
import {describe, expect, it} from 'vitest';
import {repoFromRemote} from '../core/version';

describe('配布元の判定（origin の URL → owner/name）', () => {
  it('HTTPS・SSH・.git あり無し・末尾スラッシュのどれでも読める', () => {
    for (const url of [
      'https://github.com/hiromps/reel-studio.git',
      'https://github.com/hiromps/reel-studio',
      'https://github.com/hiromps/reel-studio/',
      'git@github.com:hiromps/reel-studio.git',
      'ssh://git@github.com/hiromps/reel-studio.git',
      '  https://github.com/hiromps/reel-studio.git  ',
    ]) {
      expect(repoFromRemote(url)).toBe('hiromps/reel-studio');
    }
  });

  it('fork して使っている人は、その人のリポジトリを見る', () => {
    expect(repoFromRemote('https://github.com/someone/my-reel-studio.git')).toBe('someone/my-reel-studio');
  });

  it('GitHub 以外・読めない値のときは、同梱の配布元に落とす', () => {
    expect(repoFromRemote(null)).toBe('hiromps/reel-studio');
    expect(repoFromRemote('')).toBe('hiromps/reel-studio');
    expect(repoFromRemote('https://gitlab.com/a/b.git')).toBe('hiromps/reel-studio');
    expect(repoFromRemote('/mnt/backup/reel-studio')).toBe('hiromps/reel-studio');
  });
});
