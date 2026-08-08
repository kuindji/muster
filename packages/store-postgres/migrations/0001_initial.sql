-- Muster PostgreSQL Store schema for frozen revision 26.
-- {{schema}} is replaced only with a validated, quoted package-owned identifier.

CREATE TABLE IF NOT EXISTS {{schema}}.muster_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  name text COLLATE "C" NOT NULL UNIQUE,
  checksum text COLLATE "C" NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE {{schema}}.queue_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL CHECK (revision > 0),
  mode text NOT NULL CHECK (mode IN ('normal', 'degraded', 'admission_halted', 'emergency_halted')),
  cause text NOT NULL CHECK (cause IN ('bootstrap', 'capacity', 'sla', 'pool_offline', 'operator', 'emergency')),
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  bootstrap_fingerprint text COLLATE "C" NOT NULL CHECK (bootstrap_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE TABLE {{schema}}.class_versions (
  class_id text COLLATE "C" NOT NULL,
  contract_version text COLLATE "C" NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'active', 'draining', 'retired')),
  registered_at timestamptz NOT NULL,
  lease_disabled_at timestamptz,
  accepted_until timestamptz,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (class_id, contract_version)
);

CREATE TABLE {{schema}}.permit_epochs (
  class_id text COLLATE "C" PRIMARY KEY,
  permit_epoch text COLLATE "C" NOT NULL,
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE {{schema}}.class_health (
  class_id text COLLATE "C" PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision > 0),
  operating text NOT NULL CHECK (operating IN ('ready', 'adjudication_starved', 'admission_halted', 'emergency_halted')),
  updated_at timestamptz NOT NULL,
  adjudication_unsafe_since timestamptz,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE {{schema}}.adjudication_load (
  class_id text COLLATE "C" PRIMARY KEY REFERENCES {{schema}}.class_health(class_id),
  revision bigint NOT NULL CHECK (revision > 0),
  window_starts_at timestamptz NOT NULL,
  admitted_demand bigint NOT NULL CHECK (admitted_demand >= 0),
  oldest_pending_opened_at timestamptz,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE {{schema}}.workers (
  worker_id text COLLATE "C" PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('enrolled', 'active', 'maintenance', 'paused', 'suspended', 'revoked')),
  enrolled_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE {{schema}}.worker_routing (
  worker_id text COLLATE "C" PRIMARY KEY REFERENCES {{schema}}.workers(worker_id),
  revision bigint NOT NULL CHECK (revision > 0),
  contribution_window_id text COLLATE "C" NOT NULL,
  contribution_used bigint NOT NULL CHECK (contribution_used >= 0),
  assigned_slot_occurrence text COLLATE "C" NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE {{schema}}.core_identities (
  identity_id text COLLATE "C" PRIMARY KEY,
  identity_kind text NOT NULL CHECK (identity_kind IN ('lease', 'result_adjudication_request', 'authorization_request', 'reputation_evidence'))
);

CREATE TABLE {{schema}}.payloads (
  payload_ref text COLLATE "C" PRIMARY KEY,
  input_hash text COLLATE "C" NOT NULL,
  body jsonb NOT NULL
);

CREATE TABLE {{schema}}.jobs (
  job_id text COLLATE "C" PRIMARY KEY,
  class_id text COLLATE "C" NOT NULL,
  contract_version text COLLATE "C" NOT NULL,
  payload_ref text COLLATE "C" NOT NULL REFERENCES {{schema}}.payloads(payload_ref),
  input_hash text COLLATE "C" NOT NULL,
  collection_cycle bigint NOT NULL CHECK (collection_cycle > 0),
  lane text NOT NULL CHECK (lane IN ('normal', 'urgent')),
  priority_value bigint NOT NULL,
  enqueued_at timestamptz NOT NULL,
  sequence text COLLATE "C" NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  FOREIGN KEY (class_id, contract_version)
    REFERENCES {{schema}}.class_versions(class_id, contract_version)
);

CREATE TABLE {{schema}}.job_cycles (
  job_id text COLLATE "C" NOT NULL REFERENCES {{schema}}.jobs(job_id),
  collection_cycle bigint NOT NULL CHECK (collection_cycle > 0),
  permit_epoch text COLLATE "C" NOT NULL,
  input_hash text COLLATE "C" NOT NULL,
  cycle_started_at timestamptz NOT NULL,
  result_state text NOT NULL CHECK (result_state IN ('collecting', 'pending_result_adjudication', 'verified', 'rejected', 'expired', 'superseded', 'cancelled')),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (job_id, collection_cycle)
);

CREATE TABLE {{schema}}.attempts (
  job_id text COLLATE "C" NOT NULL,
  collection_cycle bigint NOT NULL CHECK (collection_cycle > 0),
  candidate_revision bigint NOT NULL CHECK (candidate_revision > 0),
  attempt_count bigint NOT NULL CHECK (attempt_count >= 0),
  split_observed boolean NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (job_id, collection_cycle),
  FOREIGN KEY (job_id, collection_cycle)
    REFERENCES {{schema}}.job_cycles(job_id, collection_cycle)
);

CREATE TABLE {{schema}}.leases (
  lease_id text COLLATE "C" PRIMARY KEY,
  job_id text COLLATE "C" NOT NULL,
  collection_cycle bigint NOT NULL CHECK (collection_cycle > 0),
  class_id text COLLATE "C" NOT NULL,
  contract_version text COLLATE "C" NOT NULL,
  permit_epoch text COLLATE "C" NOT NULL,
  holder text COLLATE "C" NOT NULL REFERENCES {{schema}}.workers(worker_id),
  payload_ref text COLLATE "C" NOT NULL REFERENCES {{schema}}.payloads(payload_ref),
  open boolean NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  absolute_in_flight_deadline timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  FOREIGN KEY (job_id, collection_cycle)
    REFERENCES {{schema}}.job_cycles(job_id, collection_cycle),
  FOREIGN KEY (class_id, contract_version)
    REFERENCES {{schema}}.class_versions(class_id, contract_version)
);

CREATE TABLE {{schema}}.accepted_submissions (
  lease_id text COLLATE "C" PRIMARY KEY REFERENCES {{schema}}.leases(lease_id),
  job_id text COLLATE "C" NOT NULL,
  collection_cycle bigint NOT NULL CHECK (collection_cycle > 0),
  worker_id text COLLATE "C" NOT NULL REFERENCES {{schema}}.workers(worker_id),
  result_hash text COLLATE "C" NOT NULL,
  accepted_at timestamptz NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  body jsonb NOT NULL,
  FOREIGN KEY (job_id, collection_cycle)
    REFERENCES {{schema}}.job_cycles(job_id, collection_cycle)
);

CREATE TABLE {{schema}}.decisions (
  decision_result_hash text COLLATE "C" PRIMARY KEY,
  job_id text COLLATE "C" NOT NULL,
  collection_cycle bigint NOT NULL CHECK (collection_cycle > 0),
  verified_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  UNIQUE (job_id, collection_cycle),
  FOREIGN KEY (job_id, collection_cycle)
    REFERENCES {{schema}}.job_cycles(job_id, collection_cycle)
);

CREATE TABLE {{schema}}.reserve_policies (
  class_id text COLLATE "C" NOT NULL,
  contract_version text COLLATE "C" NOT NULL,
  lane text NOT NULL CHECK (lane IN ('lowCost', 'urgent', 'splitAndAdjudication', 'audit')),
  revision bigint NOT NULL CHECK (revision > 0),
  window_id text COLLATE "C" NOT NULL,
  window_starts_at timestamptz NOT NULL,
  window_ends_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (class_id, contract_version, lane),
  FOREIGN KEY (class_id, contract_version)
    REFERENCES {{schema}}.class_versions(class_id, contract_version)
);

CREATE TABLE {{schema}}.reserve_window_history (
  class_id text COLLATE "C" NOT NULL,
  contract_version text COLLATE "C" NOT NULL,
  lane text NOT NULL CHECK (lane IN ('lowCost', 'urgent', 'splitAndAdjudication', 'audit')),
  window_id text COLLATE "C" NOT NULL,
  PRIMARY KEY (class_id, contract_version, lane, window_id)
);

CREATE TABLE {{schema}}.reserve_charges (
  charge_key text COLLATE "C" PRIMARY KEY,
  class_id text COLLATE "C" NOT NULL,
  contract_version text COLLATE "C" NOT NULL,
  lane text NOT NULL CHECK (lane IN ('lowCost', 'urgent', 'splitAndAdjudication', 'audit')),
  window_id text COLLATE "C" NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('charged', 'exhausted')),
  charged_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  FOREIGN KEY (class_id, contract_version, lane)
    REFERENCES {{schema}}.reserve_policies(class_id, contract_version, lane)
);

CREATE TABLE {{schema}}.result_adjudications (
  request_id text COLLATE "C" PRIMARY KEY,
  job_id text COLLATE "C" NOT NULL,
  collection_cycle bigint NOT NULL CHECK (collection_cycle > 0),
  class_id text COLLATE "C" NOT NULL,
  state text NOT NULL CHECK (state IN ('pending_result_adjudication', 'resolved', 'rejected', 'expired', 'superseded', 'cancelled')),
  opened_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  UNIQUE (job_id, collection_cycle),
  FOREIGN KEY (job_id, collection_cycle)
    REFERENCES {{schema}}.job_cycles(job_id, collection_cycle)
);

CREATE TABLE {{schema}}.effect_intents (
  effect_intent_id text COLLATE "C" PRIMARY KEY,
  authorization_request_id text COLLATE "C" NOT NULL UNIQUE,
  effect_intent_hash text COLLATE "C" NOT NULL,
  decision_result_hash text COLLATE "C" NOT NULL REFERENCES {{schema}}.decisions(decision_result_hash),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE {{schema}}.action_adjudications (
  authorization_request_id text COLLATE "C" PRIMARY KEY,
  class_id text COLLATE "C" NOT NULL,
  opened_at timestamptz NOT NULL,
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  context jsonb NOT NULL CHECK (jsonb_typeof(context) = 'object'),
  FOREIGN KEY (authorization_request_id)
    REFERENCES {{schema}}.effect_intents(authorization_request_id)
);

CREATE TABLE {{schema}}.verdict_history (
  request_id text COLLATE "C" PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('result', 'action')),
  verdict_hash text COLLATE "C" NOT NULL,
  processed_at timestamptz NOT NULL,
  fingerprint text COLLATE "C" NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE {{schema}}.authorizations (
  authorization_request_id text COLLATE "C" PRIMARY KEY,
  effect_intent_id text COLLATE "C" NOT NULL UNIQUE REFERENCES {{schema}}.effect_intents(effect_intent_id),
  class_id text COLLATE "C" NOT NULL,
  job_id text COLLATE "C" NOT NULL,
  collection_cycle bigint NOT NULL CHECK (collection_cycle > 0),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  FOREIGN KEY (job_id, collection_cycle)
    REFERENCES {{schema}}.job_cycles(job_id, collection_cycle)
);

CREATE TABLE {{schema}}.authorization_status (
  authorization_request_id text COLLATE "C" PRIMARY KEY REFERENCES {{schema}}.effect_intents(authorization_request_id),
  state text NOT NULL CHECK (state IN ('pending_adjudication', 'authorized', 'denied', 'expired', 'superseded', 'cancelled')),
  revision bigint NOT NULL CHECK (revision > 0),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE {{schema}}.ledger_entries (
  ledger_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL,
  class_id text COLLATE "C",
  kind text NOT NULL,
  privacy text NOT NULL CHECK (privacy IN ('public', 'internal', 'sensitive')),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE {{schema}}.reputation_evidence (
  evidence_id text COLLATE "C" PRIMARY KEY,
  worker_id text COLLATE "C" NOT NULL REFERENCES {{schema}}.workers(worker_id),
  source text NOT NULL CHECK (source IN ('checked_success', 'adjudicated_falsehood', 'deterministic_oracle', 'completeness_oracle', 'held_out_canary', 'human_audit', 'published_correction', 'structural_failure', 'validator_failure', 'post_payload_abandonment', 'escalation_quota_abuse')),
  observed_at timestamptz NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE {{schema}}.command_replays (
  command_kind text COLLATE "C" NOT NULL,
  command_key text COLLATE "C" NOT NULL,
  fingerprint text COLLATE "C" NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  outcome jsonb NOT NULL CHECK (jsonb_typeof(outcome) = 'object'),
  PRIMARY KEY (command_kind, command_key)
);

CREATE INDEX jobs_candidate_lookup_idx
  ON {{schema}}.jobs (class_id, lane, priority_value DESC, enqueued_at, sequence);
CREATE INDEX leases_open_holder_idx
  ON {{schema}}.leases (holder, job_id, collection_cycle) WHERE open;
CREATE INDEX leases_open_job_cycle_idx
  ON {{schema}}.leases (job_id, collection_cycle, lease_id) WHERE open;
CREATE INDEX result_adjudications_pending_idx
  ON {{schema}}.result_adjudications (class_id, opened_at, request_id)
  WHERE state = 'pending_result_adjudication';
CREATE INDEX action_adjudications_pending_idx
  ON {{schema}}.action_adjudications (class_id, opened_at, authorization_request_id);
CREATE INDEX accepted_submissions_cycle_idx
  ON {{schema}}.accepted_submissions (job_id, collection_cycle, accepted_at, lease_id);
CREATE INDEX authorizations_scope_idx
  ON {{schema}}.authorizations (class_id, job_id, collection_cycle, authorization_request_id);
CREATE INDEX reputation_evidence_worker_idx
  ON {{schema}}.reputation_evidence (worker_id, observed_at, evidence_id);
CREATE INDEX ledger_class_kind_idx
  ON {{schema}}.ledger_entries (class_id, kind, ledger_sequence);
