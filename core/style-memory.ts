// 案件をまたいで使う文体上の学び。AI 修正の一般化できる指示だけを保存する。
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {settingsDir} from './settings';
import {writeJsonAtomic} from './json-io';

const RuleSchema = z.object({text: z.string().min(3).max(240), learnedAt: z.string()});
const MemorySchema = z.object({version: z.literal(1), rules: z.array(RuleSchema).max(100)});
export type StyleRule = z.infer<typeof RuleSchema>;

// 明示された全台本共通の指示。保存ファイルがまだ無いときも必ず効く。
export const BASE_STYLE_RULES = [
  'テロップ・ナレーション・台本で語尾の「〜やで」など中途半端な関西弁を使わない。',
  '「○○です」で締めない。特にテロップは体言止め、または「〜すぎる」「〜すぎた・・・」のような自然な言い切りにする。ナレーションも安易な「です」で締めず、短く自然な文にする。',
];

export const styleMemoryPath = (): string => path.join(settingsDir(), 'style-memory.json');

export const loadStyleRules = (): StyleRule[] => {
  try {
    const file = styleMemoryPath();
    if (!fs.existsSync(file)) return [];
    return MemorySchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).rules;
  } catch {
    return [];
  }
};

const keyOf = (text: string) => text.replace(/[\s。．]+/g, '').toLowerCase();

export const learnStyleRules = (rules: readonly string[]): StyleRule[] => {
  const current = loadStyleRules();
  const seen = new Set([...BASE_STYLE_RULES, ...current.map((r) => r.text)].map(keyOf));
  const additions: StyleRule[] = [];
  for (const raw of rules) {
    const text = raw.trim().replace(/\s+/g, ' ');
    if (text.length < 3 || text.length > 240 || seen.has(keyOf(text))) continue;
    seen.add(keyOf(text));
    additions.push({text, learnedAt: new Date().toISOString()});
  }
  if (additions.length) writeJsonAtomic(styleMemoryPath(), {version: 1, rules: [...current, ...additions].slice(-100)});
  return additions;
};

export const globalStylePrompt = (): string => {
  const rules = [...BASE_STYLE_RULES, ...loadStyleRules().map((r) => r.text)];
  return `## 全案件に共通する文体ルール（過去の修正から学習。人格の文体より優先）\n${rules.map((r) => `- ${r}`).join('\n')}`;
};

/** 再生成時の取りこぼしを防ぐ最後の防壁。ユーザーが明示的に禁止した語尾だけを除く。 */
export const enforceStyleText = (text: string): string =>
  text.replace(/あるで(?=$|[。、！？\s]|・{3})/g, 'ある')
    .replace(/(?:やで|です)(?=$|[。、！？\s]|・{3})/g, '');

export const enforceStyleData = <T>(data: T): T => {
  const visit = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((item) => visit(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, visit(item, k)]));
    if (typeof value === 'string' && /^(text|telops?|narration|caption|tailTelop|tailNarration)$/i.test(key)) return enforceStyleText(value);
    return value;
  };
  return visit(data) as T;
};

export const shouldLearnStyleInstruction = (instruction: string): boolean =>
  /(?:やめて|使わない|禁止|避けて|しないで|今後|毎回|すべて|全て|共通|文体|語尾|言葉遣い)/.test(instruction)
  && (!/(?:この店|この料理|この動画|今回だけ)/.test(instruction) || /(?:今後|毎回|すべて|全て|共通)/.test(instruction));
