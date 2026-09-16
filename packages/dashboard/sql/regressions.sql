BEGIN;
CREATE SCHEMA IF NOT EXISTS evestack;
CREATE TABLE IF NOT EXISTS evestack.schema_version (
  component text PRIMARY KEY, version integer NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
DO $guard$
DECLARE
  target constant integer := 1;
  installed integer;
BEGIN
  SELECT version INTO installed FROM evestack.schema_version WHERE component = 'regressions';
  IF COALESCE(installed, 0) > target THEN
    RAISE EXCEPTION 'Regression storage is newer than this dashboard supports (installed %, supported %). Use the matching dashboard version; retain the recorded cases.', installed, target
      USING ERRCODE = 'EV001';
  END IF;
END $guard$;
DO $migrate$
DECLARE
  target constant integer := 1;
  installed integer;
BEGIN
  SELECT version INTO installed FROM evestack.schema_version WHERE component = 'regressions';
  installed := COALESCE(installed, 0);
  IF installed < 1 THEN
CREATE TABLE IF NOT EXISTS evestack.regression_cases (
  id uuid PRIMARY KEY,
  revision integer NOT NULL CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evestack.regression_versions (
  case_id uuid NOT NULL REFERENCES evestack.regression_cases(id),
  revision integer NOT NULL CHECK(revision>0),
  title text NOT NULL,
  correction text NOT NULL,
  expected text NOT NULL,
  baseline_session_id text NOT NULL,
  baseline_hash text NOT NULL CHECK(baseline_hash ~ '^[a-f0-9]{64}$'),
  baseline jsonb NOT NULL,
  actor text,
  actor_via text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(case_id,revision)
);
CREATE TABLE IF NOT EXISTS evestack.regression_reviews (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL,
  revision integer NOT NULL,
  candidate_session_id text NOT NULL,
  candidate_hash text NOT NULL CHECK(candidate_hash ~ '^[a-f0-9]{64}$'),
  candidate jsonb NOT NULL,
  verdict text NOT NULL CHECK(verdict IN ('observed_pass','observed_fail','needs_review')),
  note text NOT NULL,
  actor text,
  actor_via text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(case_id,revision) REFERENCES evestack.regression_versions(case_id,revision)
);
CREATE INDEX IF NOT EXISTS regression_cases_recent ON evestack.regression_cases(updated_at DESC,id);
CREATE INDEX IF NOT EXISTS regression_reviews_case ON evestack.regression_reviews(case_id,created_at DESC,id);
  END IF;
END $migrate$;
INSERT INTO evestack.schema_version (component, version)
VALUES ('regressions', 1)
ON CONFLICT (component) DO UPDATE SET version=EXCLUDED.version,applied_at=now()
WHERE evestack.schema_version.version < EXCLUDED.version;
COMMIT;
