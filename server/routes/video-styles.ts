import {Router} from 'express';
import {listVideoStyles} from '../../core/video-style';
export const videoStylesRouter = Router();
videoStylesRouter.get('/', (_req, res) => {
  try { res.setHeader('Cache-Control', 'no-cache'); res.json({entries: listVideoStyles()}); }
  catch (e) { res.status(500).json({error: (e as Error).message}); }
});
