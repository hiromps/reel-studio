// 裏で走らせる Claude のモデル選択。全画面で同じ設定を共有する（以前は 5 か所に同じコードがあった）。
import React from 'react';
import {useStringPref} from './usePref';

export const AI_MODELS = [
  ['opus', 'opus（精度重視）'],
  ['sonnet', 'sonnet（速い・安い）'],
  ['haiku', 'haiku（最安）'],
] as const;

export const useAiModel = () => useStringPref('reel-studio.aiModel', 'opus');

export const AiModelSelect: React.FC<{value: string; onChange: (v: string) => void; label?: string; title?: string}> = ({value, onChange, label = 'モデル', title}) => (
  <label title={title ?? '裏で走らせる Claude のモデル（API 課金が発生します）'}>
    {label}
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {AI_MODELS.map(([id, text]) => (
        <option key={id} value={id}>
          {text}
        </option>
      ))}
    </select>
  </label>
);
