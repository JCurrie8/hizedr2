-- A source batch is immutable, but processing it is retryable. The original
-- uniqueness constraint from 0015 accidentally made trigger_type = 'retry'
-- impossible for the same pipeline and batch.

alter table public.pipeline_runs
  drop constraint pipeline_runs_pipeline_id_source_batch_id_key;

create index pipeline_runs_pipeline_batch_idx
  on public.pipeline_runs (pipeline_id, source_batch_id, queued_at desc);
