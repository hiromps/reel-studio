// F0〜F7 のフォーマット仕様を読み込み、zod で検証して公開する。
import {FormatSpecSchema, type FormatSpec} from '../schema/format-spec';
import type {FormatId} from '../schema/brief';
import F0 from './F0.json';
import F1 from './F1.json';
import F2 from './F2.json';
import F3 from './F3.json';
import F4 from './F4.json';
import F5 from './F5.json';
import F6 from './F6.json';
import F7 from './F7.json';

const raw: Record<FormatId, unknown> = {F0, F1, F2, F3, F4, F5, F6, F7};

export const FORMAT_SPECS: Record<FormatId, FormatSpec> = Object.fromEntries(
  (Object.keys(raw) as FormatId[]).map((id) => [id, FormatSpecSchema.parse(raw[id])]),
) as Record<FormatId, FormatSpec>;

export const getFormatSpec = (id: FormatId): FormatSpec => FORMAT_SPECS[id];

export const FORMAT_IDS = Object.keys(FORMAT_SPECS) as FormatId[];
