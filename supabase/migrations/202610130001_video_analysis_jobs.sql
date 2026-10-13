-- Reproduce the supplied deployed schema; never modify an existing table.
-- Prerequisites: public.actors(id uuid PK), public.chats(id uuid PK),
-- gen_random_uuid() (Postgres 13+), and the Supabase anon/authenticated/service_role roles.
-- Existing installations require the documented drift comparison before rollout.
do $migration$
begin
  if to_regclass('public.video_analysis_jobs') is not null then
    return;
  end if;
  create table public.video_analysis_jobs (
    id uuid not null default gen_random_uuid(),
    runpod_job_id text,
    endpoint_id text not null default 'yafwsm98e8m9lv'::text,
    model text not null default 'Qwen/Qwen3-VL-8B-Instruct'::text,
    chat_id uuid,
    attachment_path text,
    request_prompt text,
    callback_token_hash text,
    status text not null default 'pending'::text,
    analysis_text text,
    model_output jsonb,
    error_code text,
    queue_ms bigint,
    inference_ms bigint,
    input_tokens integer,
    output_tokens integer,
    last_polled_at timestamptz,
    submitted_at timestamptz not null default now(),
    completed_at timestamptz,
    updated_at timestamptz not null default now(),
    chat_request_id text,
    target_chat_id uuid,
    actor_id uuid,
    assistant_message_id uuid,
    video_index integer,
    video_total integer,
    source_filename text,
    fallback_state text,
    fallback_text text,
    fallback_model text,
    fallback_started_at timestamptz,
    fallback_completed_at timestamptz,
    fallback_error_code text,
    response_delivered_at timestamptz,
    fallback_attempts integer not null default 0,
    constraint video_analysis_jobs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES actors(id) ON DELETE SET NULL,
    constraint video_analysis_jobs_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL,
    constraint video_analysis_jobs_content_limit CHECK ((char_length(COALESCE(analysis_text, ''::text)) <= 250000)),
    constraint video_analysis_jobs_id_limit CHECK ((char_length(COALESCE(runpod_job_id, ''::text)) <= 150)),
    constraint video_analysis_jobs_no_signed_source CHECK (((attachment_path IS NULL) OR ((attachment_path !~~ '%?%'::text) AND (attachment_path !~~ '%://%'::text)))),
    constraint video_analysis_jobs_pkey PRIMARY KEY (id),
    constraint video_analysis_jobs_runpod_job_id_key UNIQUE (runpod_job_id),
    constraint video_analysis_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'queued'::text, 'in_progress'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'timed_out'::text, 'expired'::text]))),
    constraint video_analysis_jobs_target_chat_id_fkey FOREIGN KEY (target_chat_id) REFERENCES chats(id) ON DELETE SET NULL
  );
  CREATE INDEX video_analysis_jobs_active_idx ON public.video_analysis_jobs USING btree (submitted_at) WHERE (status = ANY (ARRAY['pending'::text, 'queued'::text, 'in_progress'::text]));
  CREATE INDEX video_analysis_jobs_chat_idx ON public.video_analysis_jobs USING btree (chat_id, submitted_at DESC);
  CREATE INDEX video_analysis_jobs_chat_delivery_idx ON public.video_analysis_jobs USING btree (chat_request_id, video_index) WHERE (chat_request_id IS NOT NULL);
  CREATE INDEX video_analysis_jobs_pending_fallback_idx ON public.video_analysis_jobs USING btree (submitted_at) WHERE (fallback_state = 'pending'::text);
  alter table public.video_analysis_jobs enable row level security;
  -- No client policies: actor-scoped access remains in trusted application code.
  revoke all on public.video_analysis_jobs from public, anon, authenticated;
  grant all on public.video_analysis_jobs to service_role;
end
$migration$;
