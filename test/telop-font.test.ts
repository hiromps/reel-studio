// テロップの自前フォント：cuts.json の font が、実際にテロップの font-family になるか。
// エンジン（案件へ配られる engine/src）を直接描いて、出来上がりの style を見る。
import {describe, expect, it} from 'vitest';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {BadgeTelop, MainTelop, TateTelop, TelopFont, customFontFamily} from '@engine/telops';

const draw = (file: string | undefined, children: React.ReactNode): string => renderToStaticMarkup(React.createElement(TelopFont, {file, children}));

describe('telops: 自前フォント', () => {
  it('font を指定すると、メイン・バッジ・縦書きのすべてがそのフォントで描かれる', () => {
    const html = draw(
      'MyFont.otf',
      React.createElement(React.Fragment, null, [
        React.createElement(MainTelop, {key: 'm', theme: 'pop', text: 'この一杯が旨い'}),
        React.createElement(BadgeTelop, {key: 'b', theme: 'pop', text: '第1位'}),
        React.createElement(TateTelop, {key: 't', theme: 'pop', text: '東大阪', outlineColor: '#000'}),
      ]),
    );
    const family = customFontFamily('MyFont.otf');
    expect(family).toBe('reel-font-MyFont');
    expect(html.match(new RegExp(family, 'g'))).toHaveLength(3);
    // 読めなかったときのために同梱の明朝が後ろに残っている
    expect(html).toContain('Noto Serif JP');
  });

  it('font が無ければ今までどおり同梱の明朝で描く', () => {
    const html = draw(undefined, React.createElement(MainTelop, {theme: 'pop', text: 'この一杯が旨い'}));
    expect(html).toContain('Noto Serif JP');
    expect(html).not.toContain('reel-font');
  });

  it('テーマを変えてもフォントは変わらない（テーマは配色だけ）', () => {
    for (const theme of ['pop', 'bold', 'human', 'stylish'] as const) {
      expect(draw('MyFont.otf', React.createElement(MainTelop, {theme, text: 'あ'}))).toContain('reel-font-MyFont');
    }
  });
});
