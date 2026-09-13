// 指摘（E / W）の一覧。クリックでその場面へ飛べる・「適用」で自動修正できるものはボタンを出す。
import React from 'react';

export type IssueRow = {
  severity: 'E' | 'W' | 'info';
  code?: string;
  /** 行頭に出す短い印（[c03] など） */
  tag?: string;
  message: string;
  onClick?: () => void;
  fix?: {label: string; onClick: () => void};
};

export const IssueList: React.FC<{rows: IssueRow[]; empty?: React.ReactNode; maxHeight?: number}> = ({rows, empty, maxHeight}) => {
  if (!rows.length) return empty ? <div className="hint">{empty}</div> : null;
  return (
    <div className="issues" style={maxHeight ? {maxHeight} : undefined}>
      {rows.map((r, i) => (
        <div key={i} className={`issue ${r.severity === 'info' ? '' : r.severity}${r.onClick ? ' clickable' : ''}`} onClick={r.onClick}>
          <span className="code">
            {r.severity === 'info' ? '' : r.severity} {r.code ?? ''}
          </span>
          <span className="msg">
            {r.tag ? `${r.tag} ` : ''}
            {r.message}
          </span>
          {r.fix && (
            <button
              className="small"
              onClick={(e) => {
                e.stopPropagation();
                r.fix!.onClick();
              }}
            >
              {r.fix.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
};
