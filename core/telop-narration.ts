import {randomUUID} from 'node:crypto';
import {getPersona} from '../shared/personas';
import {narrationFromTelops, telopNarrationConfirmation, type TelopVoice} from '../shared/telop-narration';
import {readBrief, readCuts, readNarration, writeNarration} from './project';
import {generateTts, NO_FISH_KEY, ttsAvailable, voiceExists, type TtsOptions} from './tts';

/** PC・クラウド共通。原稿をコピーしてから同じジョブ内で Fish Audio の音声まで作る。 */
export const generateTelopNarration = async (dir: string, opt: TtsOptions & {fingerprint: string}) => {
  const read = () => {
    const brief = readBrief(dir);
    const persona = brief ? getPersona(brief.persona) : null;
    const defaults: TelopVoice = {voice: persona?.narration.voiceId ?? '', voiceTitle: persona?.narration.voiceTitle, speed: persona?.narration.speed};
    const cuts = readCuts(dir);
    const narration = readNarration(dir);
    const confirmation = telopNarrationConfirmation(cuts, narration, defaults);
    if (!opt.fingerprint || confirmation.fingerprint !== opt.fingerprint)
      throw new Error('確認後にテロップ・ナレーション・声の設定が変わりました。最新の内容で「テロップを音声化」を開き直してください');
    return {cuts, narration, defaults, confirmation};
  };
  const source = read();
  if (!ttsAvailable()) throw new Error(NO_FISH_KEY);
  const next = narrationFromTelops(source.cuts, source.narration, source.defaults, randomUUID().replace(/-/g, ''));
  if (!(next.speed! >= 0.5 && next.speed! <= 2)) throw new Error('話速は0.5〜2.0の範囲で設定してください');
  if ((await voiceExists(next.voice, {signal: opt.signal})) === false) throw new Error('選択中のボイスが Fish Audio にありません。Render で選び直してください');
  opt.signal?.throwIfAborted();
  read(); // ボイス確認中に別の画面で編集された場合も、原稿を上書きしない。
  writeNarration(dir, next);
  opt.onLine?.(`テロップの文言をそのまま ${next.segments.length} ブロックに取り込みました（空欄・未記入 ${source.confirmation.skipped} 件は除外）`);
  const result = await generateTts(dir, {...opt, ids: next.segments.map(s => s.id)});
  return {made: result.made.length, skipped: result.skipped.length, chars: result.chars, modelId: result.modelId, telops: next.segments.length};
};
