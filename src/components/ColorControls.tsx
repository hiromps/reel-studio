import React, {useEffect, useId, useState} from 'react';
import {ColorAdjustmentsSchema, isDefaultColor, type ColorAdjustments} from '@shared/color';

type Props = {
  color?: ColorAdjustments;
  onChange: (color: ColorAdjustments | undefined, field?: keyof ColorAdjustments) => void;
  onStart?: () => void;
};
const FIELDS = [
  {key: 'exposure', label: '露出', min: -2, max: 2, step: 0.05, factor: 1, unit: 'EV'},
  {key: 'brightness', label: '明るさ', min: 0, max: 200, step: 1, factor: 100, unit: '%'},
  {key: 'contrast', label: 'コントラスト', min: 0, max: 200, step: 1, factor: 100, unit: '%'},
  {key: 'saturation', label: '彩度', min: 0, max: 200, step: 1, factor: 100, unit: '%'},
] as const;

// 「-」「0.」や空欄など数値を入力している途中の文字列を保持する。
const ColorNumber: React.FC<{value: number; min: number; max: number; step: number; label: string; onStart?: () => void; onChange: (raw: string) => void}> = ({value, min, max, step, label, onStart, onChange}) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {setDraft(String(value));}, [value]);
  return <input type="number" min={min} max={max} step={step} value={draft} aria-label={label}
    onFocus={onStart}
    onBlur={() => setDraft(String(value))}
    onChange={(e) => {setDraft(e.target.value); onChange(e.target.value);}} />;
};

export const ColorControls: React.FC<Props> = ({color, onChange, onStart}) => {
  const id = useId();
  const value = ColorAdjustmentsSchema.parse(color ?? {});
  return <div className="color-controls" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {if (!e.ctrlKey && !e.metaKey) e.stopPropagation();}}>
    {FIELDS.map(({key, label, min, max, step, factor, unit}) => {
      const shown = Math.round(value[key] * factor * 100) / 100;
      const change = (raw: string) => {
        if (raw.trim() === '') return;
        const result = ColorAdjustmentsSchema.safeParse({...value, [key]: Number(raw) / factor});
        if (result.success) onChange(isDefaultColor(result.data) ? undefined : result.data, key);
      };
      const startAgain = (e: React.PointerEvent<HTMLInputElement>) => {
        if (e.currentTarget === document.activeElement) onStart?.();
      };
      return <div className="color-control-row" key={key}>
        <label htmlFor={`${id}-${key}`}>{label} <span className="dim">{unit}</span></label>
        <input id={`${id}-${key}`} type="range" min={min} max={max} step={step} value={shown} onFocus={onStart} onPointerDown={startAgain} onChange={(e) => change(e.target.value)} aria-valuetext={`${shown} ${unit}`} />
        <ColorNumber value={shown} min={min} max={max} step={step} label={`${label}（${unit}）`} onStart={onStart} onChange={change} />
      </div>;
    })}
    <button type="button" className="small" disabled={isDefaultColor(color)} onClick={() => {onStart?.(); onChange(undefined);}}>色・明るさをリセット</button>
  </div>;
};
