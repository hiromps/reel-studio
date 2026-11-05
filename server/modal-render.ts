import fs from 'node:fs';
import path from 'node:path';
import {modalConfig} from '../core/modal-vault';
import {modalFetch, modalJson} from '../core/modal-client';
import {localModalRenderProjects, setLocalModalRenderProject} from '../core/modal-render';
import {resolveProjectDirStrict} from '../core/project';
import type {ModalRenderAdapter} from '../core/modal-render-router';
export const localModalRender: ModalRenderAdapter = {
  provider: async () => ({config: modalConfig(), json: modalJson, fetch: modalFetch}),
  exists: async slug => {try {return fs.existsSync(resolveProjectDirStrict(slug));} catch {return false;}},
  get: async slug => localModalRenderProjects()[slug] ?? null,
  set: async (slug, value) => {setLocalModalRenderProject(slug, value);},
  preferLocal: (slug, logical) => {
    try {
      const dir = resolveProjectDirStrict(slug);
      const relative = logical.startsWith('studio/') ? '.studio/' + logical.slice(7) : logical.startsWith('narration/') ? logical : 'public/' + logical;
      return fs.existsSync(path.join(dir, relative));
    } catch {return false;}
  },
};
