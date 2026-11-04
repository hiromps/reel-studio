import fs from 'node:fs';
import path from 'node:path';
import {settingsDir} from './settings';
import {readJsonFile} from './json-io';
import {defaultEmotionTags, EmotionTagsSchema, type EmotionTags} from '../shared/emotion-tags';

export const loadEmotionTags = (): EmotionTags => {
  const configured = process.env.REEL_STUDIO_EMOTION_TAGS_CONFIG?.trim();
  const file = configured ? path.resolve(configured) : path.join(settingsDir(), 'emotion_tags.json');
  return configured || fs.existsSync(file) ? readJsonFile(file, EmotionTagsSchema) : defaultEmotionTags();
};
