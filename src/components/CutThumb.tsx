// カットのサムネイル。素材ファイルから IN 位置のフレームをサーバーに切り出させる（catalog を経由しない）。
// 取れなかったときだけ catalog のコンタクトシートに落ちる。
import React, {useEffect, useRef, useState} from 'react';

/** IN をドラッグで動かしている間、1 フレームごとにサーバーへ切り出させないための待ち時間 */
const REFETCH_DELAY_MS = 250;

export const cutFrameUrl = (slug: string, src: string, inSec: number, width: number): string =>
  `/api/projects/${encodeURIComponent(slug)}/frame?src=${encodeURIComponent(src)}&t=${Math.max(0, inSec).toFixed(2)}&w=${width}`;

type Props = {
  slug: string | null;
  src: string;
  inSec: number;
  /** 切り出す横幅（px）。表示サイズより少し大きめを渡す */
  width?: number;
  /** フレームが取れないときに使う画像 URL（catalog のコンタクトシートなど） */
  fallback?: string | null;
  className?: string;
  alt?: string;
};

export const CutThumb: React.FC<Props> = ({slug, src, inSec, width = 240, fallback, className, alt = ''}) => {
  const primary = slug ? cutFrameUrl(slug, src, inSec, width) : null;
  const [url, setUrl] = useState<string | null>(primary);
  const mounted = useRef(false);
  // src / IN を変えたら取り直す（fallback に落ちたままにしない）。
  // 初回は即座に、以降は少し待ってから——トリミング中に毎フレーム ffmpeg を起こさないため
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      setUrl(primary);
      return;
    }
    const t = setTimeout(() => setUrl(primary), REFETCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [primary]);

  if (!url) return <div className={`thumb-none${className ? ` ${className}` : ''}`}>no thumb</div>;
  return (
    <img
      className={className}
      src={url}
      alt={alt}
      loading="lazy"
      draggable={false}
      onError={() => setUrl(url === primary && fallback ? fallback : null)}
    />
  );
};
