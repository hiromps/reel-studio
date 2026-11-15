// テロップの文言で選んだ範囲に背景色を付ける（〖文字〗／〖文字|#RRGGBB〗で保存）。
// 入力欄からボタンへ移っても、input の選択範囲（selectionStart/End）は残るのでそれを使う。
import React, {useState} from 'react';
import {stripTelopMarks, TELOP_MARK_DEFAULT_BG, wrapTelopMark} from '@shared/telop-text';

type Props = {
  inputRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  text: string;
  onChange: (text: string) => void;
};

export const TelopMarkButtons: React.FC<Props> = ({inputRef, text, onChange}) => {
  const [color, setColor] = useState(TELOP_MARK_DEFAULT_BG);
  const [hint, setHint] = useState('');
  const marked = stripTelopMarks(text) !== text;

  const apply = () => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? 0;
    const end = el?.selectionEnd ?? 0;
    if (!el || start === end) {
      setHint('先に文言の中で、背景色を付けたい文字をドラッグして選んでください');
      return;
    }
    setHint('');
    onChange(wrapTelopMark(text, start, end, color));
  };

  return (
    <span className="row" style={{gap: 6, alignItems: 'center', flexWrap: 'wrap'}}>
      <input type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} aria-label="背景色" title="背景色" style={{width: 36, padding: 0}} />
      <button type="button" className="small" onMouseDown={(e) => e.preventDefault()} onClick={apply} title="文言で選んだ文字に背景色を付けます。〖文字〗の形で保存されます">
        選んだ範囲に背景色
      </button>
      {marked && (
        <button type="button" className="small" onClick={() => onChange(stripTelopMarks(text))} title="この文言の背景色をすべて外します">
          背景色を外す
        </button>
      )}
      {hint && <span className="hint">{hint}</span>}
    </span>
  );
};
