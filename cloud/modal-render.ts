import {randomUUID} from 'node:crypto';
import {ModalError} from '../core/modal-client';
import type {ModalRenderAdapter} from '../core/modal-render-router';
import {CatalogSchema, ReelDataSchema} from '../shared/schema';
import type {ModalRenderProject} from '../shared/modal-render';
import {calcTotalFrames} from '../shared/timeline';
import {cloudModalConnection, cloudModalFetch, cloudModalJson} from './modal';
import {kvGet, kvSet, readDoc, writeModalMedia} from './store';

export const cloudModalRender: ModalRenderAdapter = {
  provider: async () => ({config: (await cloudModalConnection()).config, json: cloudModalJson, fetch: cloudModalFetch}),
  exists: async slug => !!await readDoc(slug, 'brief'),
  get: slug => kvGet<ModalRenderProject>('modal-render-project:' + slug),
  set: (slug, value) => kvSet('modal-render-project:' + slug, value),
  activate: async (slug, session, expected) => {
    const [catalogRow, cutsRow] = await Promise.all([readDoc(slug, 'catalog'), readDoc(slug, 'cuts')]);
    if ((catalogRow?.etag ?? null) !== expected.catalogEtag || (cutsRow?.etag ?? null) !== expected.cutsEtag) throw new ModalError('素材または編集内容が変更されました。保存・再読み込みしてから取り込み直してください', 409);
    const oldCatalog = catalogRow ? CatalogSchema.parse(catalogRow.data) : null;
    const oldCuts = cutsRow ? ReelDataSchema.parse(cutsRow.data) : null;
    const videos = session.files.filter(f => f.path.startsWith('uploads/') && f.probe);
    if (!videos.length) throw new ModalError('動画の解析結果がありません', 409);
    const paths = new Set(videos.map(f => f.path));
    if (oldCuts?.cuts.some(c => !paths.has(c.src))) throw new ModalError('既存の編集に使う素材を先にPCからアップロードしてください。編集内容は保持しました', 409);
    const clips = videos.map((f, i) => {
      const old = oldCatalog?.clips.find(c => c.src === f.path);
      return {...old, id: old?.id ?? f.id, original: old?.original ?? f.path.split('/').pop()!, slug: old?.slug ?? `clip-${i+1}`, src: f.path, probe: f.probe!, thumbs: {sheet: `thumbs/${f.id}.jpg`, strip: []}, usableRanges: old?.usableRanges ?? [], user: old?.user ?? {hook: false, ng: false, orderHint: null, lock: false}};
    });
    const now = new Date().toISOString();
    const catalog = CatalogSchema.parse({version: 1, slug, materialsDir: 'Modal Cloud GPU', dominantFps: 30, createdAt: oldCatalog?.createdAt ?? now, updatedAt: now, facts: oldCatalog?.facts ?? [], clips});
    const cuts = oldCuts ?? {fps: 30, cuts: []};
    const known = new Set(oldCatalog?.clips.map(c => c.src) ?? []);
    const next = {...cuts, cuts: [...cuts.cuts]};
    for (const clip of clips) {
      if (known.has(clip.src) || next.cuts.length >= 120) continue;
      const outSec = Math.min(3, clip.probe.durationSec);
      if (calcTotalFrames(next) / next.fps + outSec > 180) break;
      next.cuts.push({id: randomUUID(), src: clip.src, inSec: 0, outSec});
    }
    const finalCuts = ReelDataSchema.parse(next);
    if (!await writeModalMedia(slug, catalog, finalCuts, expected)) throw new ModalError('素材または編集内容が変更されました。再読み込みして取り込み直してください', 409);
    return {ok: true, clips: clips.length, cuts: finalCuts.cuts.length};
  },
};
