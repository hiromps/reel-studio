// SSE が「PC が書き戻した契約ファイル」を拾うための問い合わせ。
// ローカル版の server/watch.ts（chokidar）に相当する。
import {and, eq, gt} from 'drizzle-orm';
import type {DocName} from '../shared/project';
import {db} from './db/client';
import {docs} from './db/schema';
import {docEtag} from './store';

export type DocChange = {slug: string; name: DocName; etag: string};

/** since より後に **ワーカーが** 書いた doc（画面が自分で書いたものは通知しない） */
export const docsChangedSince = async (since: Date): Promise<DocChange[]> => {
  const rows = await db()
    .select({slug: docs.slug, name: docs.name, rev: docs.rev, hash: docs.hash})
    .from(docs)
    .where(and(gt(docs.updatedAt, since), eq(docs.updatedBy, 'worker')))
    .limit(50);
  return rows.map((r) => ({slug: r.slug, name: r.name as DocName, etag: docEtag(r.rev, r.hash)}));
};
