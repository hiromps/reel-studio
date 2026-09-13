// 値の確定を少し待つ（ドラッグ中に Remotion Player を毎フレーム作り直さないため）。Timeline と Materials で共用。
import {useEffect, useState} from 'react';

export const useDebounced = <T,>(v: T, ms: number): T => {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
};
