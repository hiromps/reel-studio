import React, {useId, useState} from 'react';

/** Secondary tools stay visible on desktop and expand on compact screens. */
export const EditorMoreActions: React.FC<React.PropsWithChildren> = ({children}) => {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <>
    <button className="ed-more-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      {open ? '編集メニューを閉じる' : '編集メニュー'}
    </button>
    <div id={id} className={`ed-secondary${open ? ' open' : ''}`}>{children}</div>
  </>;
};
