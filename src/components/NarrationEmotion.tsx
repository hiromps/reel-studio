import React from 'react';
import type {NarrationSegment} from '@shared/schema';
import {emotionId} from '@shared/emotion-tags';
import {EmotionChips} from './EmotionChips';
import type {useEmotionTags} from '../hooks/useEmotionTags';

export const NarrationEmotion: React.FC<{segment: NarrationSegment; options: ReturnType<typeof useEmotionTags>; disabled?: boolean; onChange: (id: string | null) => void}> = ({segment, options, disabled, onChange}) => {
  const id = emotionId(segment.emotion_tag, options.config);
  const tag = options.config.tags.find(t => t.id === (id ?? 'none'));
  return <div className="narration-emotion" onKeyDown={e => {
    if (disabled || !options.ready || e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !/^[0-7]$/.test(e.key)) return;
    const next = e.key === '0' ? null : options.config.tags.filter(t => t.id !== 'none')[Number(e.key) - 1]?.id;
    if (next === undefined) return;
    e.preventDefault(); e.stopPropagation(); onChange(next === id ? null : next);
  }}>
    <p><b>このナレーションの感情</b>：{tag?.label ?? '既存のタグ'}<span className="hint">（音声生成に反映）</span></p>
    <EmotionChips config={options.config} value={segment.emotion_tag} label={`${segment.label || segment.id}のナレーション感情`} disabled={disabled || !options.ready} onChange={onChange} />
    {options.error && <p role="alert" className="error">{options.error}</p>}
  </div>;
};
