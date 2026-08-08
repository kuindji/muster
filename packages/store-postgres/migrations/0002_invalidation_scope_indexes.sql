-- Index the two JSON-backed predicates used to discover a complete invalidation
-- scope. Contract-visible ordering remains the TypeScript adapter's concern.

CREATE INDEX job_cycles_invalidation_class_idx
  ON {{schema}}.job_cycles ((record->>'classId'), job_id, collection_cycle);

CREATE INDEX action_adjudications_invalidation_scope_idx
  ON {{schema}}.action_adjudications (
    (request->>'jobId'),
    ((request->>'collectionCycle')::bigint),
    authorization_request_id
  );
