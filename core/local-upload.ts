import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {studioConfig} from '../studio.config';

const component = (name: string): string => {
  const clean = name.trim();
  if (!clean || clean === '.' || clean === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(clean) || /[. ]$/.test(clean) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean)) throw new Error('ファイル名またはフォルダ名が不正です');
  return clean;
};

export const saveLocalUpload = async (body: Readable, folder: string, name: string, maxBytes = 4 * 1024 ** 3): Promise<{file: string; folder: string; reused: boolean}> => {
  const safeFolder = component(folder);
  const safeName = component(name);
  const root = path.resolve(studioConfig.uploadsRoot);
  fs.mkdirSync(root, {recursive: true});
  const dir = path.join(root, safeFolder);
  fs.mkdirSync(dir, {recursive: true});
  if (path.dirname(fs.realpathSync(dir)) !== fs.realpathSync(root)) throw new Error('素材フォルダが保存先の範囲外です');
  const target = path.join(dir, safeName);
  const temp = path.join(dir, `.upload-${randomUUID()}.part`);
  const hash = createHash('sha256');
  let bytes = 0;
  const check = new Transform({transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) return callback(new Error('素材のサイズ上限を超えています'));
    hash.update(chunk);
    callback(null, chunk);
  }});
  const output = fs.createWriteStream(temp, {flags: 'wx'});
  try {
    await pipeline(body, check, output);
    if (!bytes) throw new Error('素材ファイルの中身がありません');
    const digest = hash.digest('hex');
    try {
      fs.linkSync(temp, target); // 公開は全データを書き切った後。既存ファイルは上書きしない。
      return {file: target, folder: safeFolder, reused: false};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error('同名のリンクがあります');
      const previous = createHash('sha256');
      for await (const chunk of fs.createReadStream(target)) previous.update(chunk);
      if (previous.digest('hex') !== digest) throw new Error('同名で内容の異なる素材があります。名前を変えてください');
      return {file: target, folder: safeFolder, reused: true};
    }
  } finally {
    // A rejected input can precede the asynchronous Windows open/close callbacks.
    // Wait for the writer before removing its temporary file.
    output.destroy();
    if (!output.closed) await new Promise<void>(resolve => output.once('close', resolve));
    fs.rmSync(temp, {force: true});
  }
};
