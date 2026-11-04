import React from 'react';
import {emotionId, type EmotionTags} from '@shared/emotion-tags';

export const EmotionChips: React.FC<{config: EmotionTags; value: unknown; label: string; disabled?: boolean; onChange: (id: string | null) => void}> = ({config, value, label, disabled, onChange}) => {
  const selected = emotionId(value, config);
  return <div className="emotion-chips" role="group" aria-label={label}>
    {config.tags.map(tag => {
      const id = tag.id === 'none' ? null : tag.id;
      const active = selected === id;
      return <button key={tag.id} className={`emotion-chip${active ? ' selected' : ''}`} type="button" aria-pressed={active}
        style={{'--emotion-color': tag.color} as React.CSSProperties} disabled={disabled} title={tag.note}
        onClick={() => onChange(active ? null : id)}>{active && <span aria-hidden="true">✓ </span>}{tag.label}</button>;
    })}
  </div>;
};
