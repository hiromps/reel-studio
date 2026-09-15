// 全テスト共通の前処理。ユーザーの ~/.reel-studio を絶対に触らないよう、設定の置き場を一時フォルダにする。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.REEL_STUDIO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-home-'));
// 案件フォルダの回帰テスト（schema.test.ts）は REEL_STUDIO_DATA_ROOT を明示したときだけ実データを見る
delete process.env.FISH_API_KEY;
delete process.env.FISH_MODEL_ID;
delete process.env.REEL_STUDIO_CLAUDE_BIN;
delete process.env.REEL_STUDIO_AGENT_MODEL;

// 人格はテスト用の 3 つに固定する（personas.json を読まない）
import {setPersonas} from '@shared/personas';
import {TEST_PERSONAS} from './helpers';
setPersonas(Object.values(TEST_PERSONAS));
