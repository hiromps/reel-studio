// ブラウザに記憶する軽い設定（タブ・拡大率・モデル選択など）。localStorage が使えない環境でも落ちない。
import {useCallback, useState} from 'react';

export const readPref = <T,>(key: string, fallback: T, parse: (raw: string) => T = (r) => JSON.parse(r) as T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
};

export const writePref = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    /* 記憶できなくても動作には影響しない */
  }
};

/** JSON で保存する設定。オブジェクトなら部分更新もできる */
export const usePref = <T,>(key: string, fallback: T): [T, (next: T | ((cur: T) => T)) => void] => {
  const [value, setValue] = useState<T>(() => readPref(key, fallback));
  const set = useCallback(
    (next: T | ((cur: T) => T)) => {
      setValue((cur) => {
        const v = typeof next === 'function' ? (next as (cur: T) => T)(cur) : next;
        writePref(key, v);
        return v;
      });
    },
    [key],
  );
  return [value, set];
};

/** 文字列のまま保存する設定（旧コードとの互換：JSON の引用符を付けない） */
export const useStringPref = (key: string, fallback: string): [string, (next: string) => void] => {
  const [value, setValue] = useState<string>(() => readPref(key, fallback, (r) => r));
  const set = useCallback(
    (next: string) => {
      setValue(next);
      writePref(key, next);
    },
    [key],
  );
  return [value, set];
};
