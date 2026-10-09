import React, {useRef, useState} from 'react';

type Props = {
  axis: 'x' | 'y';
  label: string;
  value: number;
  min: number;
  max: number;
  reset: number;
  onChange: (value: number) => void;
  className?: string;
  direction?: 1 | -1;
  unit?: 'px' | '%';
};

export const ResizeHandle: React.FC<Props> = ({axis, label, value, min, max, reset, onChange, className = '', direction = 1, unit = 'px'}) => {
  const start = useRef<{pointerId: number; coordinate: number; value: number} | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (next: number) => Math.max(min, Math.min(max, Math.round(next)));
  const stop = (event: React.PointerEvent<HTMLDivElement>) => {
    if (start.current?.pointerId !== event.pointerId) return;
    start.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      className={`ed-resizer ${axis === 'x' ? 'vertical' : 'horizontal'}${dragging ? ' dragging' : ''} ${className}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={clamp(value)}
      aria-valuetext={`${clamp(value)}${unit}`}
      title={`${label}。ドラッグまたは矢印キーで変更、ダブルクリックで元に戻す`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        start.current = {pointerId: event.pointerId, coordinate: axis === 'x' ? event.clientX : event.clientY, value};
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const drag = start.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const coordinate = axis === 'x' ? event.clientX : event.clientY;
        const distance = unit === '%' ? (coordinate - drag.coordinate) * 100 / Math.max(1, window.innerHeight) : coordinate - drag.coordinate;
        onChange(clamp(drag.value + distance * direction));
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => onChange(clamp(reset))}
      onKeyDown={(event) => {
        const positive = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        const negative = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        let next: number | null = null;
        const step = unit === '%' ? (event.shiftKey ? 10 : 2) : (event.shiftKey ? 60 : 20);
        if (event.key === positive) next = value + step * direction;
        if (event.key === negative) next = value - step * direction;
        if (event.key === 'Home') next = min;
        if (event.key === 'End') next = max;
        if (next === null) return;
        event.preventDefault();
        onChange(clamp(next));
      }}
    />
  );
};
