// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, expect, it} from 'vitest';
import {CloudAvailabilityNotice} from '../src/components/CloudAvailabilityNotice';
import {useStringPref} from '../src/hooks/usePref';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined, host: HTMLDivElement;
afterEach(() => {if (root) act(() => root!.unmount()); root = undefined; host?.remove(); localStorage.clear();});
const Wrapper = () => {const [show, setShow] = useStringPref('reel-studio.cloudNotice', '1'); return React.createElement(React.Fragment, null, show !== '0' && React.createElement(CloudAvailabilityNotice, {worker: {online: false, lastSeen: null}, onHide: () => setShow('0')}), React.createElement('button', {onClick: () => setShow('1')}, '再表示'));};
const mount = async () => {host = document.createElement('div');document.body.append(host);root = createRoot(host);await act(async () => root!.render(React.createElement(Wrapper)));};
it('PCなしで使える機能を先に示し、非表示を再読み込み後も保持して再表示できる', async () => {
  await mount();expect(host.textContent).toContain('PCなしで使えます');expect(host.querySelector('details')!.open).toBe(false);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="利用できる機能の案内を非表示"]')!.click());
  expect(host.querySelector('.cloud-availability')).toBeNull();expect(localStorage.getItem('reel-studio.cloudNotice')).toBe('0');
  act(() => root!.unmount());host.remove();await mount();expect(host.querySelector('.cloud-availability')).toBeNull();
  await act(async () => host.querySelector('button')!.click());expect(host.querySelector('.cloud-availability')).not.toBeNull();
});
