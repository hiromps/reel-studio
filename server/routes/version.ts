// 版の確認と更新。手元の版と GitHub の最新を比べ、`git pull --ff-only` まで行う。
// npm install はここではやらない（動いているサーバーが node_modules を掴んでいるため、
// 次の起動でランチャーが入れ直す）。
import {Router} from 'express';
import {checkUpdate, localVersion, pullUpdate} from '../../core/version';

export const versionRouter = Router();

versionRouter.get('/', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache');
    // ?check=0 なら GitHub に問い合わせず手元の版だけ返す（起動直後の表示用）
    if (req.query.check === '0') return res.json({local: await localVersion(), latest: null, behind: null, commits: [], problem: null, checkedAt: new Date().toISOString()});
    res.json(await checkUpdate({refresh: req.query.refresh === '1'}));
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
  }
});

/** git pull --ff-only。npm install はしない（動いているサーバーが node_modules を掴んでいるため） */
versionRouter.post('/update', async (_req, res) => {
  try {
    res.json(await pullUpdate());
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
  }
});
