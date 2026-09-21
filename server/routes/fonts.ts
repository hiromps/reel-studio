// 自前フォントの取り込み・一覧・削除。実体は <設定の置き場>/fonts/（core/fonts.ts）。
//
// 取り込んだフォントは、案件の cuts.json で `font` に指定されたときに public/fonts/ へ配られる
// （保存時＝server/routes/files.ts、レンダー直前＝core/render.ts）。ここでは置き場だけを扱う。
import express, {Router} from 'express';
import {deleteFont, fontsDir, listFonts, saveFont} from '../../core/fonts';
import {loadSettings, mergeSettings, saveSettings} from '../../core/settings';
import {FONT_MAX_BYTES, safeFontFile} from '../../shared/schema/fonts';

export const fontsRouter = Router();

const view = () => ({dir: fontsDir(), fonts: listFonts(), selected: loadSettings().telop.font ?? null});

fontsRouter.get('/', (_req, res) => res.json(view()));

/**
 * 取り込み。本文はフォントファイルそのもの（JSON ではない）で、名前は ?filename= で渡す。
 * multipart にしないのは、フォームの解析ライブラリを増やさないため。
 */
fontsRouter.post('/', express.raw({type: () => true, limit: FONT_MAX_BYTES}), (req, res) => {
  const name = safeFontFile(String(req.query.filename ?? ''));
  const body = req.body;
  if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({error: 'フォントファイルの中身がありません'});
  try {
    const font = saveFont(name, body);
    res.json({font, ...view()});
  } catch (e) {
    res.status(400).json({error: (e as Error).message});
  }
});

/** 置き場から消す。配り済み（案件の public/fonts/）はそのまま＝既存の動画の見た目は変わらない */
fontsRouter.delete('/:file', (req, res) => {
  const file = safeFontFile(req.params.file);
  if (!deleteFont(file)) return res.status(404).json({error: `そのフォントはありません: ${file}`});
  // 既定に選ばれていたら外す（無いフォントを指したままにしない）
  const cur = loadSettings();
  if (cur.telop.font === file) saveSettings(mergeSettings(cur, {telop: {font: null}}));
  res.json(view());
});
