import React from 'react';
import {ZoomSchema, type Zoom} from '@shared/zoom';

type Props = {zoom?: Zoom; onChange: (zoom: Zoom | undefined) => void; onStart: () => void};

/** 一覧とインスペクタで同じ操作。連続入力はonStartで1回だけ履歴を積む。 */
export const ZoomControls: React.FC<Props> = ({zoom, onChange, onStart}) => {
  const value = ZoomSchema.parse(zoom ?? {mode: 'none'});
  const disabled = value.mode === 'none';
  const strength = Math.max(value.scale_start, value.scale_end);
  const patch = (p: Partial<Zoom>) => {
    const result = ZoomSchema.safeParse({...value, ...p});
    if (result.success) onChange(result.data);
  };
  return (
    <div className="zoom-controls" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {if (!e.ctrlKey && !e.metaKey) e.stopPropagation();}}>
      <label>ズーム
        <select value={value.mode} onChange={(e) => {
          onStart();
          const mode = e.target.value as Zoom['mode'];
          onChange(mode === 'none' ? undefined : ZoomSchema.parse({...value, mode, scale_start: mode === 'pull' ? Math.max(1.05, strength === 1 ? 1.2 : strength) : 1, scale_end: mode === 'push' ? Math.max(1.05, strength === 1 ? 1.18 : strength) : 1}));
        }}>
          <option value="none">なし</option><option value="push">ズームイン</option><option value="pull">ズームアウト</option>
        </select>
      </label>
      <label>強さ {strength.toFixed(2)}倍
        <input type="range" min={1.05} max={1.5} step={0.01} value={Math.max(1.05, strength)} disabled={disabled} onFocus={onStart} onChange={(e) => {
          const scale = Number(e.target.value);
          patch(value.mode === 'pull' ? {scale_start: scale, scale_end: Math.min(value.scale_end, scale)} : {scale_end: scale, scale_start: Math.min(value.scale_start, scale)});
        }} />
      </label>
      <label>イージング
        <select value={value.ease} disabled={disabled} onChange={(e) => {onStart(); patch({ease: e.target.value as Zoom['ease']});}}>
          <option value="in_out">ゆっくり→速く→ゆっくり</option><option value="out">終わりで緩む</option><option value="linear">一定速度</option>
        </select>
      </label>
      <div className="zoom-pair">
        {(['anchor_x', 'anchor_y'] as const).map((key) => <label key={key}>アンカー{key === 'anchor_x' ? 'X' : 'Y'}
          <input type="number" min={0} max={1} step={0.05} value={value[key]} disabled={disabled} onFocus={onStart} onChange={(e) => {if (e.target.value !== '') patch({[key]: Number(e.target.value)});}} />
        </label>)}
      </div>
      <div className="zoom-pair">
        {(['scale_start', 'scale_end'] as const).map((key) => <label key={key}>{key === 'scale_start' ? '開始倍率' : '終了倍率'}
          <input type="number" min={1} max={1.5} step={0.01} value={value[key]} disabled={disabled} onFocus={onStart} onChange={(e) => {if (e.target.value !== '') patch({[key]: Number(e.target.value)});}} />
        </label>)}
      </div>
    </div>
  );
};
