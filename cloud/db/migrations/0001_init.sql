-- Reel Studio クラウド版の初期スキーマ。
-- 契約ファイル（docs）・ジョブ・メディア索引（assets）・人格・小さな単発の値（kv）。
-- 冪等に書く（IF NOT EXISTS）。定義の正は cloud/db/schema.ts。

CREATE TABLE IF NOT EXISTS projects (
  slug        text PRIMARY KEY,
  persona     text,
  shop_name   text,
  format      text,
  info        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE IF NOT EXISTS docs (
  slug        text NOT NULL,
  name        text NOT NULL,
  data        jsonb,
  rev         integer NOT NULL DEFAULT 1,
  hash        text NOT NULL,
  updated_by  text NOT NULL DEFAULT 'cloud',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, name)
);

CREATE TABLE IF NOT EXISTS jobs (
  id                text PRIMARY KEY,
  slug              text NOT NULL,
  type              text NOT NULL,
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'queued',
  progress          jsonb,
  result            jsonb,
  error             text,
  log_seq           integer NOT NULL DEFAULT 0,
  cancel_requested  boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  ended_at          timestamptz,
  claimed_at        timestamptz,
  heartbeat_at      timestamptz
);

-- ワーカーの取得（queued を古い順に1件）と、画面の一覧（新しい順）で引く
CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS jobs_created_desc_idx ON jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS job_logs (
  job_id  text NOT NULL,
  seq     integer NOT NULL,
  line    text NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE IF NOT EXISTS assets (
  slug          text NOT NULL,
  kind          text NOT NULL,
  mode          text NOT NULL DEFAULT 'full',
  rel_path      text NOT NULL,
  url           text NOT NULL,
  bytes         integer NOT NULL DEFAULT 0,
  hash          text NOT NULL DEFAULT '',
  content_type  text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, kind, mode, rel_path)
);

CREATE TABLE IF NOT EXISTS personas (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kv (
  key         text PRIMARY KEY,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
