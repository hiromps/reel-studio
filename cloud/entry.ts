// バンドルの入口（scripts/build-api.mjs が読む）。api/_app.cjs になる。
import {createApp} from './app';

// 最後の砦。ここに来るのはルータの外（タイマーや後始末）で漏れた reject だけだが、
// 落とすと同じインスタンスの他のリクエストまで 504 になるので、ログに残して生かす。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : reason);
});

export default createApp();
