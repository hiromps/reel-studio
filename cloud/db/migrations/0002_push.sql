-- 通知（Web Push）の購読先。レンダーや仕上げが終わったときにスマホへ知らせる。
-- endpoint が購読の識別子（ブラウザ・端末ごとに 1 つ）。失効したら 404/410 が返るので、その場で消す。
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint    text PRIMARY KEY,
  keys        jsonb NOT NULL,
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_sent   timestamptz
);
