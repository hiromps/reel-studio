// 版の確認と更新（ローカル専用）。クラウド側にはこの経路が無い＝画面もボタンを出さない
// （クラウドの画面は Vercel にデプロイした版で動くので、更新は git push → デプロイ）。
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
