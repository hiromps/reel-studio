import {useEffect, useState} from 'react';
import {api} from '../api';
import {defaultEmotionTags, EmotionTagsSchema} from '@shared/emotion-tags';

export const useEmotionTags = () => {
  const [config, setConfig] = useState(defaultEmotionTags);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api.get('/api/emotion-tags').then(r => {
      if (active) {setConfig(EmotionTagsSchema.parse(r.data)); setReady(true);}
    }).catch(e => {if (active) setError(`感情タグを読み込めません: ${e.message}`);});
    return () => {active = false;};
  }, []);
  return {config, ready, error};
};
