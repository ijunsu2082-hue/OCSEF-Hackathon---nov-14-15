-- Apply to a dedicated TimescaleDB instance (not Supabase's PostgreSQL service).
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS workflow_telemetry_targets (
  target_key text PRIMARY KEY,
  workspace_id text NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  caiso_node text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_telemetry_targets_workspace_idx ON workflow_telemetry_targets (workspace_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS workflow_telemetry_observations (
  workspace_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('noaa-nws', 'caiso-oasis', 'operator')),
  series text NOT NULL,
  target text NOT NULL,
  observed_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL,
  value double precision NOT NULL,
  unit text NOT NULL,
  source_revision text NOT NULL DEFAULT 'unversioned',
  source_url text NOT NULL,
  qualifiers jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (workspace_id, provider, series, target, observed_at, source_revision)
);
SELECT create_hypertable('workflow_telemetry_observations', 'observed_at', if_not_exists => true);
CREATE INDEX IF NOT EXISTS workflow_telemetry_observations_scope_time_idx ON workflow_telemetry_observations (workspace_id, observed_at DESC);

-- Freeze model outputs and their exact inputs before measurements. The API never accepts
-- calibration evidence from provider observations; operator-measurement ingestion stays gated.
CREATE TABLE IF NOT EXISTS workflow_telemetry_prediction_freezes (
  freeze_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  asset_key text NOT NULL,
  model_version text NOT NULL,
  input_snapshot jsonb NOT NULL,
  created_by text NOT NULL,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workflow_telemetry_frozen_predictions (
  freeze_id uuid NOT NULL REFERENCES workflow_telemetry_prediction_freezes(freeze_id),
  workspace_id text NOT NULL,
  target text NOT NULL,
  predicted_for timestamptz NOT NULL,
  value double precision NOT NULL,
  unit text NOT NULL,
  PRIMARY KEY (freeze_id, target, predicted_for, unit)
);
CREATE TABLE IF NOT EXISTS workflow_telemetry_measurements (
  measurement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  asset_key text NOT NULL,
  target text NOT NULL,
  observed_at timestamptz NOT NULL,
  value double precision NOT NULL,
  unit text NOT NULL,
  instrument_id text NOT NULL,
  evidence_ref text NOT NULL CHECK (length(trim(evidence_ref)) > 0),
  qualification_status text NOT NULL DEFAULT 'pending' CHECK (qualification_status IN ('pending', 'qualified', 'rejected')),
  qualification_note text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  qualified_by text,
  qualified_at timestamptz
);
CREATE TABLE IF NOT EXISTS workflow_telemetry_replay_runs (
  replay_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  asset_key text NOT NULL,
  freeze_id uuid NOT NULL REFERENCES workflow_telemetry_prediction_freezes(freeze_id),
  commissioning_at timestamptz NOT NULL,
  minimum_pairs_per_period integer NOT NULL DEFAULT 3 CHECK (minimum_pairs_per_period >= 1),
  result jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('insufficient-data', 'ready-for-independent-review')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workflow_telemetry_replay_reviews (
  review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  replay_id uuid NOT NULL REFERENCES workflow_telemetry_replay_runs(replay_id),
  workspace_id text NOT NULL,
  reviewer_id text NOT NULL,
  reviewer_name text NOT NULL,
  reviewer_credential text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  evidence_ref text NOT NULL,
  notes text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_telemetry_replay_reviews_replay_idx ON workflow_telemetry_replay_reviews (replay_id, reviewed_at DESC);

-- Calibration is never inferred from public providers or an unreviewed replay.
CREATE TABLE IF NOT EXISTS workflow_telemetry_calibration (
  workspace_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending-commissioning' CHECK (status IN ('pending-commissioning', 'review-required', 'verified')),
  accepted_review_id uuid REFERENCES workflow_telemetry_replay_reviews(review_id),
  verified_at timestamptz,
  reviewer text,
  commissioning_reference text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'verified' OR (accepted_review_id IS NOT NULL AND verified_at IS NOT NULL AND reviewer IS NOT NULL AND commissioning_reference IS NOT NULL))
);

CREATE OR REPLACE FUNCTION workflow_telemetry_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'frozen telemetry records are immutable';
END;
$$;
DROP TRIGGER IF EXISTS workflow_telemetry_freeze_immutable ON workflow_telemetry_prediction_freezes;
CREATE TRIGGER workflow_telemetry_freeze_immutable BEFORE UPDATE OR DELETE ON workflow_telemetry_prediction_freezes FOR EACH ROW EXECUTE FUNCTION workflow_telemetry_immutable_record();
DROP TRIGGER IF EXISTS workflow_telemetry_prediction_immutable ON workflow_telemetry_frozen_predictions;
CREATE TRIGGER workflow_telemetry_prediction_immutable BEFORE UPDATE OR DELETE ON workflow_telemetry_frozen_predictions FOR EACH ROW EXECUTE FUNCTION workflow_telemetry_immutable_record();

-- Least privilege. The worker owns inserts; API uses a read-only account after checking Clerk workspace membership.
REVOKE ALL ON workflow_telemetry_targets, workflow_telemetry_observations, workflow_telemetry_prediction_freezes,
  workflow_telemetry_frozen_predictions, workflow_telemetry_measurements, workflow_telemetry_replay_runs,
  workflow_telemetry_replay_reviews, workflow_telemetry_calibration FROM PUBLIC;
