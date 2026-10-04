// DeepSeek の鍵が通るかの確認（Settings の「テスト」）。残高 API を叩くだけなので課金は発生しない。
// 実際の生成は core/agent.ts が claude を DeepSeek の Anthropic 互換 API に向けて走らせる（providerEnv）。

export type DeepseekProbe = {ok: boolean; message: string; balance?: string};

type BalanceResponse = {
  is_available?: boolean;
  balance_infos?: {currency?: string; total_balance?: string}[];
};

/** GET https://api.deepseek.com/user/balance。鍵そのものは返さない・メッセージにも入れない */
export const probeDeepseekKey = async (apiKey: string, opt: {signal?: AbortSignal} = {}): Promise<DeepseekProbe> => {
  let res: Response;
  try {
    res = await fetch('https://api.deepseek.com/user/balance', {headers: {Authorization: `Bearer ${apiKey}`, Accept: 'application/json'}, signal: opt.signal});
  } catch (e) {
    return {ok: false, message: `DeepSeek に繋がりませんでした（${(e as Error).name === 'TimeoutError' ? '時間切れ' : (e as Error).message}）`};
  }
  if (res.status === 401) return {ok: false, message: 'API キーが通りませんでした（401）。キーを確かめてください'};
  if (!res.ok) return {ok: false, message: `DeepSeek が ${res.status} を返しました`};
  const body = (await res.json().catch(() => ({}))) as BalanceResponse;
  const balance = (body.balance_infos ?? []).map((b) => `${b.total_balance ?? '?'} ${b.currency ?? ''}`.trim()).join(' / ');
  if (body.is_available === false) return {ok: false, balance, message: `鍵は通りましたが残高が足りません${balance ? `（残高 ${balance}）` : ''}`};
  return {ok: true, balance, message: `繋がりました${balance ? `（残高 ${balance}）` : ''}`};
};
