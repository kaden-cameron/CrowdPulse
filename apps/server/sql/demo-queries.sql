-- CrowdPulse demo queries for TigerData (Doc 03 §6). Run in the TigerData SQL editor or psql.

-- Latest events for the demo session
SELECT time, event_type, participant_id, value, metadata
FROM crowd_events
WHERE session_id = 'demo'
ORDER BY time DESC
LIMIT 20;

-- Votes by track (should match the host dashboard "Votes by track (SQL)")
SELECT metadata->>'trackId' AS track_id, COUNT(*) AS votes
FROM crowd_events
WHERE session_id = 'demo' AND event_type = 'vote'
GROUP BY 1
ORDER BY votes DESC;

-- 5-second continuous aggregate, newest first
SELECT bucket, event_count, votes, taps, ROUND(avg_energy) AS avg_energy
FROM crowd_metrics_5s
WHERE session_id = 'demo'
ORDER BY bucket DESC
LIMIT 24;

-- Freshness: newest raw event vs newest materialized bucket
SELECT
  (SELECT MAX(time) FROM crowd_events WHERE session_id = 'demo') AS newest_event,
  (SELECT MAX(bucket) FROM crowd_metrics_5s WHERE session_id = 'demo') AS newest_aggregate_bucket;

-- Proof of the hypertable and aggregate policy
SELECT hypertable_name, num_chunks FROM timescaledb_information.hypertables;
SELECT view_name, materialized_only FROM timescaledb_information.continuous_aggregates;
SELECT application_name, schedule_interval, config
FROM timescaledb_information.jobs
WHERE application_name LIKE 'Refresh Continuous Aggregate%';
