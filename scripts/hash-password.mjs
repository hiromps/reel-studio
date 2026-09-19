#!/usr/bin/env node
// クラウド版のログインパスワードを AUTH_PASSWORD_HASH の形（scrypt$salt$hash）にする。
//
//   node scripts/hash-password.mjs            … 打ち込んだ文字は画面に出ない
//   node scripts/hash-password.mjs <password> … 引数で渡す（履歴に残るので手元だけで）
//
// 出た 1 行を Vercel の環境変数 AUTH_PASSWORD_HASH に入れる。
import {randomBytes, scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import readline from 'node:readline';

const scryptAsync = promisify(scrypt);

const ask = () =>
  new Promise((resolve) => {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    // 入力中の文字を表示しない
    const onData = () => rl.output.write('\x1b[2K\rパスワード: ');
    rl.input.on('data', onData);
    rl.question('パスワード: ', (answer) => {
      rl.input.off('data', onData);
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });

const password = process.argv[2] ?? (await ask());
if (!password || password.length < 8) {
  console.error('8 文字以上にしてください');
  process.exit(1);
}
const salt = randomBytes(16);
const hash = await scryptAsync(password, salt, 32);
console.log(`scrypt$${salt.toString('hex')}$${hash.toString('hex')}`);
