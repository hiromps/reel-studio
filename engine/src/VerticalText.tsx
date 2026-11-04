import React from 'react';

/** ASCII digit runs become a single horizontal unit inside a vertical line. */
export const verticalTextParts = (text: string): {text: string; digits: boolean}[] =>
  text.split(/([0-9]+)/).filter(Boolean).map(part => ({text: part, digits: /^[0-9]+$/.test(part)}));

export const verticalTextCells = (text: string): number => verticalTextParts(text).reduce((n, part) => n + (part.digits ? 1 : part.text.length), 0);

export const VerticalText: React.FC<{text: string}> = ({text}) => <>
  {verticalTextParts(text).map((part, i) => part.digits
    ? <span key={i} data-tate-chu-yoko="digits" style={{textCombineUpright: 'all', letterSpacing: 0}}>{part.text}</span>
    : <React.Fragment key={i}>{part.text}</React.Fragment>)}
</>;
