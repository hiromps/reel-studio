// 仕上げパイプラインの段取り（何が済んでいて何を走らせるか）を返す。実行は jobs の 'build'。
import {Router, type Request} from 'express';
import {buildPlan} from '../../core/build';
import {resolveProjectDirStrict} from '../../core/project';

export const buildRouter = Router({mergeParams: true});

const slugOf = (req: Request): string => (req.params as unknown as {slug: string}).slug;

buildRouter.get('/build', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache');
    res.json(buildPlan(resolveProjectDirStrict(slugOf(req))));
  } catch (e) {
    res.status(400).json({error: (e as Error).message});
  }
});
