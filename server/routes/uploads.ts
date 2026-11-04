import {Router} from 'express';
import {resolveProjectDirStrict} from '../../core/project';
import {saveLocalUpload} from '../../core/local-upload';

export const uploadsRouter = Router();
uploadsRouter.post('/local', async (req, res) => {
  try {
    const slug = String(req.query.slug ?? '');
    resolveProjectDirStrict(slug);
    const folder = String(req.query.folder || slug.replace(/-reel$/, ''));
    const result = await saveLocalUpload(req, folder, String(req.query.filename ?? ''));
    res.json(result);
  } catch (error) {
    res.status(400).json({error: (error as Error).message});
  }
});
