// エージェントの稼働状況 → 進捗表示。画を見ずに考えている間も「動いている」ことが出ること。
import {describe, expect, it} from 'vitest';
import {activitySummary, createAgentTracker, fmtElapsed, progressView, shortTarget} from '../shared/agent-progress';

const clock = (start = 0) => {
  let t = start;
  return {now: () => t, tick: (sec: number) => (t += sec * 1000)};
};

describe('createAgentTracker', () => {
  it('起動前は「起動しています」。init で started になる', () => {
    const c = clock();
    const tr = createAgentTracker(['a.jpg', 'b.jpg'], c.now);
    expect(progressView(tr.stats)).toEqual({done: 0, total: 0, phase: 'claude を起動しています（0秒）'});
    c.tick(7);
    expect(tr.onEvent({kind: 'init', model: 'claude-opus'})).toBe('init');
    expect(tr.stats.started).toBe(true);
    expect(tr.stats.model).toBe('claude-opus');
    const v = progressView(tr.stats, {thinking: '原稿を考えています'});
    expect(v.total).toBe(0); // 数えられる作業が無い＝流れる帯
    expect(v.phase).toContain('原稿を考えています');
    expect(v.phase).toContain('7秒');
  });

  it('画を見ずに考えている間も heartbeat で経過秒・ツール回数・出力文字数が進む', () => {
    const c = clock();
    const tr = createAgentTracker(['a.jpg'], c.now);
    tr.onEvent({kind: 'init'});
    tr.onEvent({kind: 'thinking'});
    tr.onEvent({kind: 'text', text: 'あいうえお'});
    tr.onEvent({kind: 'tool', name: 'Glob', input: {pattern: '**/*.json'}});
    expect(tr.onEvent({kind: 'heartbeat', elapsedSec: 95})).toBe('heartbeat');
    expect(tr.stats.elapsedSec).toBe(95);
    const v = progressView(tr.stats);
    expect(v.total).toBe(0);
    expect(v.phase).toBe('AI が考えています（1分35秒・ツール 1 回・出力 5 文字）');
    expect(tr.stats.lastTool).toBe('Glob');
    expect(tr.stats.lastTarget).toBe('**/*.json');
  });

  it('見せた画像の Read だけを数え、その他の Read は数えない', () => {
    const tr = createAgentTracker(['C:/x/.studio/cutframes/a.jpg', 'b.jpg']);
    tr.onEvent({kind: 'init'});
    expect(tr.onEvent({kind: 'tool', name: 'Read', input: {file_path: 'cuts.json'}})).toBe('tool');
    expect(tr.stats.watched.done).toBe(0);
    expect(tr.onEvent({kind: 'tool', name: 'Read', input: {file_path: '.studio/cutframes/a.jpg'}})).toBe('watched');
    expect(tr.onEvent({kind: 'tool', name: 'Read', input: {file_path: '.studio/cutframes/a.jpg'}})).toBe('tool'); // 2 回目は数えない
    const v = progressView(tr.stats, {reading: '画を確認中'});
    expect(v.done).toBe(1);
    expect(v.total).toBe(2);
    expect(v.phase).toContain('画を確認中 1/2（a.jpg）');
    expect(tr.stats.reads).toBe(3);
  });

  it('StructuredOutput で書き出しに入り、満タンになる', () => {
    const tr = createAgentTracker(['a.jpg', 'b.jpg']);
    tr.onEvent({kind: 'init'});
    tr.onEvent({kind: 'tool', name: 'Read', input: {file_path: 'a.jpg'}});
    expect(tr.onEvent({kind: 'tool', name: 'StructuredOutput', input: {}})).toBe('writing');
    const v = progressView(tr.stats, {writing: '原稿を書き出しています'});
    expect(v).toMatchObject({done: 2, total: 2});
    expect(v.phase).toContain('原稿を書き出しています');
    // 見せる画が無いときは流れる帯のまま
    const tr2 = createAgentTracker();
    tr2.onEvent({kind: 'tool', name: 'StructuredOutput', input: {}});
    expect(progressView(tr2.stats).total).toBe(0);
  });

  it('tool_result は数えない', () => {
    const tr = createAgentTracker();
    expect(tr.onEvent({kind: 'tool_result'})).toBe('none');
    expect(tr.stats.tools).toBe(0);
  });
});

describe('表示の補助', () => {
  it('fmtElapsed', () => {
    expect(fmtElapsed(0)).toBe('0秒');
    expect(fmtElapsed(59.6)).toBe('1分00秒');
    expect(fmtElapsed(125)).toBe('2分05秒');
  });
  it('shortTarget はツールごとに要点だけ', () => {
    expect(shortTarget('Read', {file_path: 'C:\\a\\b\\c.jpg'})).toBe('c.jpg');
    expect(shortTarget('WebSearch', {query: 'bonjour arima 営業時間'})).toBe('「bonjour arima 営業時間」');
    expect(shortTarget('WebFetch', {url: 'https://www.instagram.com/x/'})).toBe('www.instagram.com/x/');
    expect(shortTarget('StructuredOutput', {})).toBe('');
  });
  it('activitySummary は 0 のものを省く', () => {
    const tr = createAgentTracker();
    expect(activitySummary(tr.stats)).toBe('0秒');
    tr.onEvent({kind: 'tool', name: 'Glob', input: {}});
    expect(activitySummary(tr.stats)).toBe('0秒・ツール 1 回');
  });
});
