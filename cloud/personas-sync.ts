// 人格（persona）を DB から shared/personas.ts のレジストリに載せる。
//
// 人格は「誰の声・文体で作るか」の定義で、検証・キャプション点検・構成プランがこれを見る。
// サーバーレスの実行環境は使い回されるので、毎リクエスト読み直さず少しだけ覚えておく。
import {PersonaSchema, setPersonas, type Persona} from '../shared/personas';
import {listPersonaRows} from './store';

const TTL_MS = 10_000;
let loadedAt = 0;

export const ensurePersonas = async (): Promise<void> => {
  if (Date.now() - loadedAt < TTL_MS) return;
  const rows = await listPersonaRows();
  const list: Persona[] = [];
  for (const r of rows) {
    const p = PersonaSchema.safeParse(r);
    if (p.success) list.push(p.data);
  }
  // 1 件も無い（初回）ときは同梱の人格のままにする
  if (list.length) setPersonas(list);
  loadedAt = Date.now();
};

/** 人格を保存した直後に呼ぶ（次のリクエストで確実に読み直させる） */
export const invalidatePersonas = (): void => {
  loadedAt = 0;
};
