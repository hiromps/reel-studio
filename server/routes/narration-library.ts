import {Router} from 'express';
import {deleteNarrationFromLibrary, listNarrationLibrary, narrationLibraryAudio, saveNarrationToLibrary, useNarrationFromLibrary} from '../../core/narration-library';

export const narrationLibraryRouter = Router();

narrationLibraryRouter.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json({entries: listNarrationLibrary()});
});

narrationLibraryRouter.post('/', (req, res) => {
  try {
    res.json({entry: saveNarrationToLibrary(req.body)});
  } catch (error) {
    res.status(400).json({error: (error as Error).message});
  }
});

narrationLibraryRouter.get('/:id/audio', (req, res) => {
  const file = narrationLibraryAudio(req.params.id);
  if (!file) return res.status(404).json({error: '音声が見つかりません'});
  res.setHeader('Cache-Control', 'no-cache');
  res.type('wav').sendFile(file);
});

narrationLibraryRouter.post('/:id/use', (req, res) => {
  try {
    res.json({entry: useNarrationFromLibrary(req.params.id, req.body?.project, req.body?.segmentId)});
  } catch (error) {
    res.status(400).json({error: (error as Error).message});
  }
});

narrationLibraryRouter.delete('/:id', (req, res) => {
  res.json({removed: deleteNarrationFromLibrary(req.params.id)});
});
