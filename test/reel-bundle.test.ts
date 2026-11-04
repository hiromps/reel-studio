import {expect, it} from 'vitest';
import {createReelCut} from '../shared/reel-cuts';
import {updateReelBundle} from '../shared/reel-bundle';
import {stableHash} from '../shared/hash';

const first = () => updateReelBundle('reelCuts', [createReelCut('uploads/food.mp4', undefined, {id: 'one', line: 'お肉が最高です'})], {});
it('クラウドの編集・音声・台本を同じ共通カットへ反映する', () => {
  const initial = first();
  const editor = structuredClone(initial.cuts); editor.cuts[0].inSec = 1; editor.cuts[0].outSec = 4;
  const edited = updateReelBundle('cuts', editor, initial);
  expect(edited.reelCuts[0]).toMatchObject({start: 1, duration: 3});
  expect(edited.narration.videoSec).toBe(3); expect(edited.script.text).toContain('0〜3秒');
  const script = updateReelBundle('script', {text: edited.script.text.replace('お肉が最高です', 'お肉がとろけます')}, edited);
  expect(script.reelCuts[0].line).toBe('お肉がとろけます');
  expect(script.narration.segments[0].text).toBe('お肉がとろけます');
  const narration = structuredClone(script.narration); narration.segments[0].text = '旨みたっぷりです'; narration.segments[0].speed = 1.5;
  expect(updateReelBundle('narration', narration, script).reelCuts[0]).toMatchObject({line: '旨みたっぷりです', speed: 1.5});
});
it('クラウド同期の前後でJSONハッシュが変わらない', () => {
  const bundle = first();
  for (const doc of Object.values(bundle)) expect(stableHash(doc)).toBe(stableHash(JSON.parse(JSON.stringify(doc))));
});
it('素材の差し替え時に古いローカルキャッシュへ戻さない', () => {
  const bundle = first();
  bundle.reelCuts[0].clip_path = 'C:/media/first.mp4'; bundle.cuts.cuts[0].src = 'uploads/cached-first.mp4';
  const unchanged = updateReelBundle('reelCuts', bundle.reelCuts, bundle);
  expect(unchanged.cuts.cuts[0].src).toBe('uploads/cached-first.mp4');
  const changed = structuredClone(bundle.reelCuts); changed[0].clip_path = 'C:/media/second.mp4';
  expect(updateReelBundle('reelCuts', changed, bundle).cuts.cuts[0].src).toBe('C:/media/second.mp4');
});
it('音声配置を単独で変えて共通カットとずれる保存を拒否する', () => {
  const bundle = first();
  const narration = structuredClone(bundle.narration); narration.segments[0].at = 1;
  expect(() => updateReelBundle('narration', narration, bundle)).toThrow('音声配置');
});
