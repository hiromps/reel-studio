// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';

const mocked = vi.hoisted(() => ({store: null as any}));
vi.mock('../src/state/store', () => ({useStudio: () => mocked.store}));
vi.mock('../src/hooks/useAiModel', () => ({useAiModel: () => ['test-model', () => {}], AiModelSelect: () => null}));
import {AiMenu} from '../src/editor/AiMenu';

const hosts: HTMLElement[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.remove(); });

it('Claude に頼むを受け付けたとき、AI の反映より前の状態をアンドゥ用に記録する', async () => {
  const events: string[] = [];
  mocked.store = {
    jobs: [], files: {cuts: {dirty: false}, narration: {dirty: false}}, supportsJob: () => true,
    addJob: vi.fn(async () => { events.push('submit'); return {id: 'job-1'}; }), toast: vi.fn(),
  };
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(AiMenu, {
    onJobRequest: () => { events.push('capture'); return (id: string) => events.push(`accept:${id}`); },
    placeholders: 0, cutCount: 26, hasCuts: true, hasOrderCheck: false,
  })));
  act(() => (host.querySelector('.ai-btn') as HTMLButtonElement).click());
  const rewrite = [...host.querySelectorAll<HTMLButtonElement>('.ai-item')].find((button) => button.textContent?.includes('テロップを全部書き直す'))!;
  await act(async () => { rewrite.click(); });
  expect(events).toEqual(['capture', 'submit', 'accept:job-1']);
  act(() => root.unmount());
});
