-- Supabase 向けの守り。
--
-- Supabase は public スキーマの表を REST（PostgREST）でも公開する。anon キーは画面に埋める性質のもので
-- 秘密ではないので、RLS が無いと **anon キーだけでこの表を読み書きできてしまう**。
-- Reel Studio はこの REST を使わず、接続文字列（postgres ロール＝表の持ち主）で直接繋ぐ。
-- 持ち主は RLS の対象外なので、ポリシーを 1 つも作らずに RLS を有効にすれば
-- 「アプリは今までどおり、REST からは何も見えない」になる。
--
-- 併せて anon / authenticated から権限を外す（ロールが無い素の Postgres でも通るように存在を見る）。
-- 冪等。Supabase 以外の Postgres に当てても害は無い。

ALTER TABLE projects  ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE personas  ENABLE ROW LEVEL SECURITY;
ALTER TABLE kv        ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE projects, docs, jobs, job_logs, assets, personas, kv, push_subs FROM %I', r);
    END IF;
  END LOOP;
END
$$;
