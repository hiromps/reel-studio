// 画面全体のキーボードショートカット。入力欄の中では発火しない（IME 変換中も同様）。
import {useEffect, useRef} from 'react';

export type Hotkey = {
  /** e.key（大文字小文字は区別しない）。'Space' は ' ' として扱う */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** 入力欄にフォーカスがあっても効かせる（Ctrl+S など） */
  inInputs?: boolean;
  handler: (e: KeyboardEvent) => void;
};

export const isEditableTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
};

const matches = (e: KeyboardEvent, h: Hotkey): boolean => {
  const want = h.key === 'Space' ? ' ' : h.key;
  if (e.key.toLowerCase() !== want.toLowerCase()) return false;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!!h.ctrl !== ctrl) return false;
  if (!!h.shift !== e.shiftKey) return false;
  if (!!h.alt !== e.altKey) return false;
  return true;
};

/** 登録した順に照合し、最初に合ったものだけ実行する（preventDefault 済み） */
export const useHotkeys = (keys: Hotkey[], enabled = true) => {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const editable = isEditableTarget(e.target);
      for (const k of ref.current) {
        if (editable && !k.inInputs) continue;
        if (!matches(e, k)) continue;
        e.preventDefault();
        k.handler(e);
        return;
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [enabled]);
};
