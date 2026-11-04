import {useRef, useState} from 'react';
import {useStudio} from '../state/store';

/** Save the selected emotion before queuing just this audio block. */
export const useNarrationRegeneration = () => {
  const s = useStudio();
  const latest = useRef(s);
  latest.current = s;
  const lock = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const busy = s.jobs.some(j => j.slug === s.active && ['queued', 'running'].includes(j.status));
  const blocked = !s.supportsJob('tts') ? 'Reel Studio とPCワーカーを更新してください'
    : s.config?.tts === false ? 'Fish Audio のAPIキーを設定してください'
    : busy || submitting ? 'この案件の処理が終わってから生成してください' : null;
  const regenerate = async (id: string) => {
    if (blocked || lock.current) return;
    const target = s.files.narration.data?.segments.find(seg => seg.id === id);
    const slug = s.active;
    if (!target?.text.trim() || !slug) return;
    lock.current = true; setSubmitting(true);
    try {
      for (const name of ['brief', 'cuts', 'narration'] as const) {
        if (latest.current.active !== slug) throw new Error('案件が切り替わったため、生成を中止しました');
        if (s.files[name].dirty && !(await s.saveFile(name))) throw new Error('保存できなかったため、音声を生成していません');
      }
      if (latest.current.active !== slug) throw new Error('案件が切り替わったため、生成を中止しました');
      const job = await s.addJob('tts', {ids: [id], force: true}, slug);
      if (!job) throw new Error('音声生成を開始できませんでした');
    } catch (e) {s.toast((e as Error).message, 'error');}
    finally {lock.current = false; setSubmitting(false);}
  };
  return {regenerate, blocked, submitting};
};
