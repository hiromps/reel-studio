// 裏で走らせる claude へのプロンプトの渡し方。長いプロンプトは argv に載せず標準入力で渡す
// （Windows はコマンドライン全体で 32,767 文字まで。超えると spawn が ENAMETOOLONG で落ちる）。
import {describe, expect, it} from 'vitest';
import {agentArgs, PROMPT_ARGV_MAX, PROMPT_STDIN_LEAD, promptTransport} from '../core/agent';
import {exec} from '../core/exec';

describe('promptTransport / agentArgs', () => {
  it('短いプロンプトはそのまま -p に載せる', () => {
    expect(promptTransport('短い依頼')).toEqual({arg: '短い依頼'});
    const args = agentArgs({cwd: '.', prompt: '短い依頼', schema: {type: 'object'}});
    expect(args.slice(0, 2)).toEqual(['-p', '短い依頼']);
  });

  it('上限を超えるプロンプトは案内だけ -p に書き、本文は stdin に回す', () => {
    const long = '動画の分析 '.repeat(PROMPT_ARGV_MAX / 6 + 100);
    expect(long.length).toBeGreaterThan(PROMPT_ARGV_MAX);
    const t = promptTransport(long);
    expect(t.arg).toBe(PROMPT_STDIN_LEAD);
    expect(t.stdin).toBe(long);
    const args = agentArgs({cwd: '.', prompt: long, schema: {type: 'object'}});
    expect(args[1]).toBe(PROMPT_STDIN_LEAD);
    // argv 全体が Windows の上限に収まる
    expect(args.join(' ').length).toBeLessThan(32_000);
    expect(args).not.toContain(long);
  });

  it('境界: ちょうど上限は argv、1 文字超えたら stdin', () => {
    expect(promptTransport('a'.repeat(PROMPT_ARGV_MAX)).stdin).toBeUndefined();
    expect(promptTransport('a'.repeat(PROMPT_ARGV_MAX + 1)).stdin).toBeDefined();
  });
});

describe('exec の input（標準入力）', () => {
  it('input を渡すと子プロセスの stdin に流れて閉じる', async () => {
    const script = 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(String(s.length)+":"+s.slice(0,8))})';
    const body = 'こんにちは'.repeat(5000);
    const r = await exec(process.execPath, ['-e', script], {input: body, timeoutMs: 30_000});
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${body.length}:${body.slice(0, 8)}`);
  });

  it('input が無ければ stdin は閉じたまま（読む側は空で終わる）', async () => {
    const script = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write("len="+s.length)).on("error",()=>process.stdout.write("len=0"))';
    const r = await exec(process.execPath, ['-e', script], {timeoutMs: 30_000});
    expect(r.stdout).toBe('len=0');
  });
});
