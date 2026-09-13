// caption.txt の機械的な点検。文章の良し悪しは見ない（それは人と AI の仕事）。
// 判定の根拠は各人格の SKILL.md「Step 4: キャプションの生成」と、繰り返し指摘された規則。
import type {Persona} from './personas';

export type CaptionIssue = {severity: 'E' | 'W'; code: string; message: string};

/** 保存・いいね・シェア・コメントを促す文言は禁止（来店を促す CTA は可） */
const ENGAGEMENT_BAIT = [
  {re: /保存(して|しとい|推奨|必須|は|を)/, label: '保存を促す文言'},
  {re: /いいね(して|お願い|よろしく|が励み)/, label: 'いいねを促す文言'},
  {re: /(シェア|拡散)(して|お願い|よろしく)/, label: 'シェア・拡散を促す文言'},
  {re: /コメント(して|で教え|お待ち|欲しい|ください)/, label: 'コメントを促す文言'},
  {re: /フォロー(して|お願い|よろしく)/, label: 'フォローを促す文言'},
];

export const hashtagsOf = (caption: string): string[] => caption.match(/#[^\s#]+/g) ?? [];

/** 未確定を表すプレースホルダ（AI に埋めさせず残させる印） */
const PLACEHOLDER = /(＿＿+|【要確認】|\{\{[^}]*\}\})/;

export const checkCaption = (caption: string, persona: Persona, opt: {pr?: boolean} = {}): CaptionIssue[] => {
  const out: CaptionIssue[] = [];
  const text = caption.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (!text.trim()) return [{severity: 'E', code: 'EMPTY', message: 'キャプションが空です'}];

  const tags = hashtagsOf(text);
  if (tags.length !== persona.caption.hashtags) out.push({severity: 'W', code: 'HASHTAG_COUNT', message: `ハッシュタグが ${tags.length} 個（${persona.label} は ${persona.caption.hashtags} 個ちょうど）`});
  if (tags.some((t) => /^#pr$/i.test(t))) out.push({severity: 'W', code: 'HASHTAG_PR', message: 'ハッシュタグ列に #PR は入れない（PR 表記は店名の直後の小文字 pr だけ）'});

  for (const b of ENGAGEMENT_BAIT) if (b.re.test(text)) out.push({severity: 'E', code: 'ENGAGEMENT_BAIT', message: `${b.label}は禁止（来店を促す一文は可）`});

  // 文末の句点。ハッシュタグ行と「〜。」で終わる注記も含めて一律で見る
  const dotted = lines.filter((l) => /[。]\s*$/.test(l));
  if (dotted.length) out.push({severity: 'W', code: 'TRAILING_PERIOD', message: `文末に句点「。」がある行が ${dotted.length} 行（「${dotted[0].trim().slice(0, 20)}…」）`});

  if (PLACEHOLDER.test(text)) out.push({severity: 'W', code: 'PLACEHOLDER', message: '未確定のプレースホルダが残っています（品名・価格・住所などを確認して埋める）'});

  const chars = [...text.replace(/\s/g, '')].length;
  if (persona.caption.maxChars && chars > persona.caption.maxChars) out.push({severity: 'W', code: 'TOO_LONG', message: `${chars} 文字（目安 ${persona.caption.maxChars} 文字まで）。スクロールされずに離脱される`});

  if (opt.pr && !/(^|[^A-Za-z])pr([^A-Za-z]|$)/m.test(text)) out.push({severity: 'W', code: 'PR_MISSING', message: 'PR 案件なのに「pr」表記がありません（店名の直後に小文字 pr を 1 箇所）'});
  if (!opt.pr && /』\s*pr|」\s*pr/.test(text)) out.push({severity: 'W', code: 'PR_UNEXPECTED', message: 'PR 案件ではないのに店名の後に pr が付いています'});

  if (persona.caption.repostAccount && !text.includes(`@${persona.caption.repostAccount}`))
    out.push({severity: 'W', code: 'REPOST_ACCOUNT', message: `自分のアカウント @${persona.caption.repostAccount} への誘導行がありません`});

  return out;
};

export const formatCaptionIssues = (issues: CaptionIssue[]): string => (issues.length ? issues.map((i) => `  ${i.severity} ${i.code} ${i.message}`).join('\n') : '  指摘なし');
