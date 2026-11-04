import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {VerticalText, verticalTextCells, verticalTextParts} from '@engine/VerticalText';
import {MainTelop, TateTelop} from '@engine/telops';

it('groups each ASCII number without changing the original text', () => {
  const text = '10月29日に2026年の第1弾を公開';
  const parts = verticalTextParts(text);
  expect(parts.filter(p => p.digits).map(p => p.text)).toEqual(['10', '29', '2026', '1']);
  expect(parts.map(p => p.text).join('')).toBe(text);
  expect(verticalTextParts('１０月ABC')).toEqual([{text: '１０月ABC', digits: false}]);
  expect(verticalTextCells('10月にリニューアルした')).toBe('0月にリニューアルした'.length);
});
it('uses horizontal upright numeric spans only in vertical main and persistent telops', () => {
  const text = '10月にリニューアルした';
  const html = renderToStaticMarkup(React.createElement(MainTelop, {text, theme: 'pop'}));
  expect(html).toContain('text-combine-upright:all');
  expect(html).toMatch(/data-tate-chu-yoko="digits"[^>]*>10<\/span>月/);
  expect(html).toContain('writing-mode:vertical-rl');
  expect(renderToStaticMarkup(React.createElement(MainTelop, {text, theme: 'pop', orientation: 'horizontal'}))).not.toContain('text-combine-upright');
  expect(renderToStaticMarkup(React.createElement(TateTelop, {text: '10月', theme: 'pop', outlineColor: '#000'}))).toContain('text-combine-upright:all');
  expect(renderToStaticMarkup(React.createElement(VerticalText, {text: '数字なし'}))).toBe('数字なし');
});
