// @vitest-environment jsdom
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({frame: 0}));
vi.mock('remotion', () => ({
  AbsoluteFill: ({children, style}: any) => React.createElement('div', {style}, children),
  Sequence: ({children}: any) => React.createElement('div', null, children),
  OffthreadVideo: ({src, startFrom, playbackRate, style}: any) => React.createElement('video', {src, style, 'data-start': startFrom, 'data-rate': playbackRate}),
  staticFile: (src: string) => src,
  useCurrentFrame: () => state.frame,
}));
vi.mock('../engine/src/telops', () => ({
  TelopFont: ({children}: any) => children,
  MainTelop: ({text}: any) => React.createElement('span', {'data-telop': 'main'}, text),
  PriceTelop: ({text}: any) => React.createElement('span', {'data-telop': 'price'}, text),
  BadgeTelop: ({text}: any) => React.createElement('span', {'data-telop': 'badge'}, text),
  TateTelop: ({text}: any) => React.createElement('span', {'data-telop': 'tate'}, text),
}));
import {GourmetReel, type ReelData} from '../engine/src/GourmetReel';
import {viralZoom} from '../shared/zoom';

const data: ReelData = {fps: 30, tate: {text: '店名', outlineColor: 'black'}, cuts: [{
  src: 'grid.mp4', inSec: 1, outSec: 1 + 46 / 30, playbackRate: 2, crop: {zoom: 1.1, x: 0.3, y: 0.7}, zoom: viralZoom(0),
  price: {text: '1000円'}, badge: '順位', subs: [{text: '字幕', startSec: 1, endSec: 1.5}],
}, {src: 'b.mp4', inSec: 0, outSec: 1, main: {text: 'メイン'}}]};
const transforms = (el: Element) => {
  const result: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    const transform = (node as HTMLElement).style.transform;
    if (transform) result.push(transform);
  }
  return result;
};

it('開始/中間/終了で映像だけをズームし、crop・音声用の開始/倍速・全テロップレイヤーを保持する', () => {
  for (const [frame, scale] of [[0, 1], [11, 1.225], [22, 1.45]]) {
    state.frame = frame;
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(React.createElement(GourmetReel, data));
    const video = host.querySelector('video')!;
    expect(video.dataset.start).toBe('30'); expect(video.dataset.rate).toBe('2');
    expect(video.style.transform).toBe('scale(1.1000)');
    const actual = transforms(video);
    expect(actual).toHaveLength(scale === 1 ? 1 : 2);
    if (scale !== 1) expect(Number(actual[1].slice(6, -1))).toBeCloseTo(scale, 12);
    expect(host.querySelectorAll('[data-telop]')).toHaveLength(5);
    for (const telop of host.querySelectorAll('[data-telop]')) expect(transforms(telop)).toEqual([]);
  }
});
it('noneと設定なしは同じDOM・スタイル・映像プロパティになる', () => {
  const omitted = {...data, cuts: data.cuts.map((c) => ({...c, zoom: undefined}))};
  const none = {...data, cuts: data.cuts.map((c) => ({...c, zoom: {...viralZoom(0), mode: 'none' as const}}))};
  expect(renderToStaticMarkup(React.createElement(GourmetReel, none))).toBe(renderToStaticMarkup(React.createElement(GourmetReel, omitted)));
});
