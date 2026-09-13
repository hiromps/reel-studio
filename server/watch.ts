// 開かれている案件の契約ファイルを chokidar で監視し、変更を SSE（file:changed）へ流す。
//
// タブごとに違う案件を開けるので、監視も 1 案件では足りない（タブ A の案件を見張っている間に
// タブ B が別案件を開くと、A の外部変更が届かなくなる）。開かれた案件を順に足していき、
// 古いものから閉じる。1 案件あたり 4 ファイルなので、この程度なら常時見張っていて問題ない。
import {EventEmitter} from 'node:events';
import path from 'node:path';
import chokidar, {type FSWatcher} from 'chokidar';
import {CONTRACT_FILES} from '../core/project';
import {fileEtag} from '../core/json-io';

export const watcher = new EventEmitter();

/** 同時に見張る案件の数。超えたら触っていない順に閉じる */
const MAX_WATCHED = 8;

const watchers = new Map<string, FSWatcher>();
/** 最後に使われた順（先頭が最も古い） */
const order: string[] = [];

const touch = (dir: string) => {
  const i = order.indexOf(dir);
  if (i >= 0) order.splice(i, 1);
  order.push(dir);
};

export const watchProject = (dir: string) => {
  if (watchers.has(dir)) return touch(dir);
  const files = CONTRACT_FILES.map((n) => path.join(dir, `${n}.json`));
  const w = chokidar.watch(files, {ignoreInitial: true, awaitWriteFinish: {stabilityThreshold: 200, pollInterval: 50}});
  const emit = (file: string) => {
    const name = path.basename(file, '.json');
    watcher.emit('changed', {slug: path.basename(dir), name, etag: fileEtag(file)});
  };
  w.on('change', emit).on('add', emit).on('unlink', emit);
  watchers.set(dir, w);
  touch(dir);
  while (order.length > MAX_WATCHED) {
    const oldest = order.shift()!;
    void watchers.get(oldest)?.close();
    watchers.delete(oldest);
  }
};

/** いま監視している案件フォルダ（テスト・デバッグ用） */
export const watchedProjects = (): string[] => [...order];
