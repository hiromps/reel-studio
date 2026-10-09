import {afterAll, afterEach, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runAgent} from '../core/agent';
import {codexOutputSchema} from '../core/codex';
import {resetSettings} from '../core/settings';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-codex-test-'));
const binDir = path.join(temp, 'bin');
fs.mkdirSync(binDir, {recursive: true});
const entry = process.platform === 'win32' ? path.join(temp, '@openai', 'codex', 'bin', 'codex.js') : path.join(binDir, 'codex');
fs.mkdirSync(path.dirname(entry), {recursive: true});
fs.writeFileSync(entry, `#!/usr/bin/env node
const args = process.argv.slice(2);
const fs = require('fs');
const path = require('path');
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in'); process.exit(0); }
if (args[0] === 'exec') {
  let input = '';
  process.stdin.on('data', (chunk) => input += chunk);
  process.stdin.on('end', () => {
    if (!args.includes('read-only') || !args.includes('future-model') || !input.includes('JSON')) process.exit(2);
    console.log(JSON.stringify({type: 'thread.started'}));
    console.log(JSON.stringify({type: 'turn.started'}));
    if (input.includes('CAPACITY')) {
      const marker = path.join(process.cwd(), '.capacity-attempts');
      const attempts = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
      fs.writeFileSync(marker, String(attempts + 1));
      if (attempts === 0) {
        console.log(JSON.stringify({type: 'turn.failed', error: {message: 'Selected model is at capacity. Please try a different model.'}}));
        process.exit(1);
      }
    }
    if (input.includes('FAIL')) {
      console.log(JSON.stringify({type: 'turn.failed', error: {message: 'model output limit reached'}}));
      process.exit(1);
    }
    console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: '{"ok":true}'}}));
    console.log(JSON.stringify({type: 'turn.completed', turn: {status: 'completed'}}));
  });
} else process.exit(3);
`, 'utf8');
if (process.platform !== 'win32') fs.chmodSync(entry, 0o755);
const bin = process.platform === 'win32' ? path.join(binDir, 'codex.cmd') : entry;
if (process.platform === 'win32') fs.writeFileSync(bin, '', 'utf8');

afterEach(() => {
  delete process.env.REEL_STUDIO_CODEX_BIN;
  delete process.env.REEL_STUDIO_AGENT_PROVIDER;
  delete process.env.REEL_STUDIO_HOME;
  resetSettings();
});
afterAll(() => {
  const resolved = path.resolve(temp);
  if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith('reel-codex-test-')) fs.rmSync(resolved, {recursive: true, force: true});
});

it('Codex の構造化出力では入れ子の全項目を required にする', () => {
  const source = {type: 'object', properties: {cuts: {type: 'array', items: {type: 'object', properties: {clipId: {type: 'string'}, telop: {type: 'string'}}, required: ['clipId']}}}, required: ['cuts']};
  const schema = codexOutputSchema(source) as {properties: {cuts: {items: {required: string[]}}}};
  expect(schema.properties.cuts.items.required).toEqual(['clipId', 'telop']);
  expect(source.properties.cuts.items.required).toEqual(['clipId']);
});

it('Codex 接続先では Claude CLI を通さず、選択モデルで JSON Schema の結果を受け取る', async () => {
  process.env.REEL_STUDIO_CODEX_BIN = bin;
  process.env.REEL_STUDIO_AGENT_PROVIDER = 'codex';
  process.env.REEL_STUDIO_HOME = temp;
  resetSettings();
  const result = await runAgent<{ok: boolean}>({
    cwd: temp, prompt: 'Return JSON with ok true', model: 'future-model',
    schema: {type: 'object', properties: {ok: {type: 'boolean'}}, required: ['ok'], additionalProperties: false},
  });
  expect(result.data).toEqual({ok: true});
  expect(result.turns).toBe(1);
});

it('Codex の失敗イベントの理由をエラーに含める', async () => {
  process.env.REEL_STUDIO_CODEX_BIN = bin;
  process.env.REEL_STUDIO_AGENT_PROVIDER = 'codex';
  process.env.REEL_STUDIO_HOME = temp;
  resetSettings();
  await expect(runAgent({
    cwd: temp, prompt: 'Return JSON. FAIL', model: 'future-model',
    schema: {type: 'object', properties: {ok: {type: 'boolean'}}, required: ['ok'], additionalProperties: false},
  })).rejects.toThrow('model output limit reached');
});

it('モデルの容量不足だけを同じモデルで再試行する', async () => {
  process.env.REEL_STUDIO_CODEX_BIN = bin;
  process.env.REEL_STUDIO_AGENT_PROVIDER = 'codex';
  process.env.REEL_STUDIO_HOME = temp;
  resetSettings();
  const logs: string[] = [];
  const result = await runAgent<{ok: boolean}>({
    cwd: temp, prompt: 'Return JSON. CAPACITY', model: 'future-model',
    schema: {type: 'object', properties: {ok: {type: 'boolean'}}, required: ['ok'], additionalProperties: false},
    onLine: (line) => logs.push(line),
  });
  expect(result.data).toEqual({ok: true});
  expect(fs.readFileSync(path.join(temp, '.capacity-attempts'), 'utf8')).toBe('2');
  expect(logs.some((line) => line.includes('再試行'))).toBe(true);
});
