// 「まだ何も無い」画面で、次に何をすればいいかを出すカード。
// 初めての人が行き止まりに見えないようにするためのもの。
import React from 'react';

type Props = {
  title: string;
  /** やることの手順（1 行ずつ） */
  steps?: React.ReactNode[];
  children?: React.ReactNode;
  action?: {label: string; onClick: () => void};
  hint?: React.ReactNode;
};

export const EmptyState: React.FC<Props> = ({title, steps, children, action, hint}) => (
  <section className="card empty-state">
    <h2>{title}</h2>
    {children}
    {steps && steps.length > 0 && (
      <ol className="empty-steps">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    )}
    {action && (
      <button className="primary" onClick={action.onClick}>
        {action.label}
      </button>
    )}
    {hint && <p className="hint">{hint}</p>}
  </section>
);
