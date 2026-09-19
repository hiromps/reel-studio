// Vercel Functions の入口。/api/**、/events、/p/** をこの 1 本で受ける（vercel.json の rewrites）。
//
// 中身は api/_app.cjs（scripts/build-api.mjs が cloud/ を 1 ファイルに畳んだもの。ビルドで生成される）。
// Vercel は api/ のファイルを「型を外して変換」するだけで依存をまとめないため、
// ここから relative import で cloud/ を読むと実行時に解決できない。だから先に畳んでおく。
const mod = require('./_app.cjs');

module.exports = mod.default ?? mod;
