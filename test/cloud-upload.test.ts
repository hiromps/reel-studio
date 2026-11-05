import {File} from 'node:buffer';
import {expect, it, vi, beforeEach} from 'vitest';
import {createHash} from 'node:crypto';
import {MODAL_UPLOAD_CHUNK, type ModalSession} from '../shared/modal-render';
import {planCloudUpload, uploadCloudFiles} from '../src/cloud-upload';
import {modalApi} from '../src/modal-api';
vi.mock('../src/modal-api', () => ({modalApi: {post: vi.fn()}}));
const post = vi.mocked(modalApi.post);
const file = (bytes: Uint8Array, name = 'sample.mp4') => new File([bytes], name) as unknown as globalThis.File;
beforeEach(() => {post.mockReset();});

it('2MiB単位でSHA256付き転送を行い、応答消失後も同じIDで再開する', async () => {
  const bytes = new Uint8Array(MODAL_UPLOAD_CHUNK + 3).fill(43);
  const plan = planCloudUpload([file(bytes)], null);
  let lost = false;
  post.mockImplementation(async route => {
    if (route.endsWith('/sessions')) return {id: plan.id, files: [{id: plan.files[0].id, complete: false}]} as any;
    if (route.endsWith('/chunks/0') && !lost) {lost = true; throw new Error('lost response');}
    return {} as any;
  });
  await expect(uploadCloudFiles('test', plan, new AbortController().signal, vi.fn())).rejects.toThrow('lost response');
  await uploadCloudFiles('test', plan, new AbortController().signal, vi.fn());
  const chunks = post.mock.calls.filter(c => c[0].includes('/chunks/'));
  expect(chunks[0].slice(0, 2)).toEqual(chunks[1].slice(0, 2));
  const payload = chunks[2][1] as {data: string; sha256: string};
  expect(Buffer.from(payload.data, 'base64')).toEqual(Buffer.from([43, 43, 43]));
  expect(payload.sha256).toBe(createHash('sha256').update(Buffer.from([43,43,43])).digest('hex'));
  expect(post.mock.lastCall![0]).toBe('/render/projects/test/commit-session');
});

it('転送完了済みファイルは再送せず、中止時は案件へ反映しない', async () => {
  const plan = planCloudUpload([file(new Uint8Array([1]))], null);
  post.mockResolvedValue({id: plan.id, files: [{id: plan.files[0].id, complete: true}]} as any);
  await uploadCloudFiles('test', plan, new AbortController().signal, vi.fn());
  expect(post.mock.calls.some(c => c[0].includes('/chunks/'))).toBe(false);
  const controller = new AbortController();
  post.mockReset().mockImplementation(async () => {controller.abort(); return {files: [{id: plan.files[0].id, complete: false}]} as any;});
  await expect(uploadCloudFiles('test', plan, controller.signal, vi.fn())).rejects.toThrow();
  expect(post.mock.calls.some(c => c[0].endsWith('/commit-session'))).toBe(false);
});

it('転送前に容量と形式を検証し、既存素材を再利用する', () => {
  expect(() => planCloudUpload([file(new Uint8Array([1]), 'a.m3u8')], null)).toThrow('MP4');
  expect(() => planCloudUpload([file(new Uint8Array())], null)).toThrow();
  const previous = {id: crypto.randomUUID(), totalBytes: 1024 ** 3, files: []} as unknown as ModalSession;
  expect(() => planCloudUpload([file(new Uint8Array([1]))], previous)).toThrow('合計');
  expect(planCloudUpload([file(new Uint8Array([1]))], {...previous, totalBytes: 1}).expectedSessionId).toBe(previous.id);
});
