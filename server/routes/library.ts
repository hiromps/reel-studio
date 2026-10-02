// 参考動画のライブラリ（同じ動画の分析を案件をまたいで使い回す置き場）の一覧と、名前付け。
// 実体は <設定の置き場>/reference-library/。写す・登録は案件側のルート（routes/reference.ts）。
import {Router} from 'express';
import {deleteLibraryEntry, libraryIndex, setLibraryTitle} from '../../core/reference';

export const libraryRouter = Router();

libraryRouter.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json({entries: libraryIndex()});
});

/** 名前を付ける（空で消す）。同じ動画を写している案件の表示名も揃える */
libraryRouter.put('/:key', (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title : '';
  try {
    res.json({entry: setLibraryTitle(req.params.key, title)});
  } catch (e) {
    res.status(404).json({error: (e as Error).message});
  }
});

/** 1 本を消す（動画・コマ・分析。戻せない）。案件に写した分析は残る */
libraryRouter.delete('/:key', (req, res) => {
  try {
    res.json({removed: deleteLibraryEntry(req.params.key)});
  } catch (e) {
    res.status(404).json({error: (e as Error).message});
  }
});
