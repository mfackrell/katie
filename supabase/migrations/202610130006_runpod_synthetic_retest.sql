-- Append one allowlisted tombstone; never reset or mutate the original claim.
alter table public.runpod_synthetic_validation drop constraint runpod_synthetic_validation_slot_check;
alter table public.runpod_synthetic_validation add constraint runpod_synthetic_validation_slot_check
  check (slot in ('wp4', 'wp4-retest'));

-- All IDs are generated here; no caller-supplied user IDs. Setup and claim are atomic.
create function public.claim_runpod_synthetic_validation_retest() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.runpod_synthetic_validation; begin
  -- Lock the old ledger row; absent or uncleaned old tests cannot authorize a new POST.
  perform 1 from public.runpod_synthetic_validation where slot='wp4' and cleaned_at is not null for update;
  if not found then raise exception 'Original validation must be cleaned'; end if;
  insert into public.runpod_synthetic_validation(slot,actor_id,chat_id,assistant_id,attachment_id)
  values ('wp4-retest',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid())
  on conflict do nothing returning * into r;
  if r.slot is null then return null; end if;
  insert into public.actors(id,name,system_prompt,review_mode)
  values(r.actor_id,'SYNTHETIC WP4 RETEST','Describe synthetic visual test evidence only.', 'off');
  insert into public.chats(id,actor_id,title) values(r.chat_id,r.actor_id,'SYNTHETIC WP4 RETEST ONLY');
  insert into public.messages(id,actor_id,chat_id,role,content)
  values(r.assistant_id,r.actor_id,r.chat_id,'assistant','[Katie video analysis pending: synthetic-wp4-retest]' || chr(10) || 'Synthetic validation pending.');
  insert into public.chat_requests(request_id,actor_id,chat_id,request_fingerprint,status,assistant_message_id)
  values('synthetic-wp4-retest',r.actor_id::text,r.chat_id::text,'synthetic-wp4-retest','processing',r.assistant_id::text);
  return to_jsonb(r);
end $$;
revoke all on function public.claim_runpod_synthetic_validation_retest() from public, anon, authenticated;
grant execute on function public.claim_runpod_synthetic_validation_retest() to service_role;

-- Remove only ledger-owned rows; retain claim forever. Delete jobs first to stop future cron work.
create function public.cleanup_runpod_synthetic_validation_retest() returns void
language plpgsql security definer set search_path = public as $$
declare r public.runpod_synthetic_validation; begin
  select * into r from public.runpod_synthetic_validation where slot='wp4-retest' for update;
  if r.slot is null or r.cleaned_at is not null then return; end if;
  if now() < r.deadline_at
  then raise exception 'Validation is still active'; end if;
  delete from public.video_analysis_jobs where chat_request_id='synthetic-wp4-retest' and actor_id=r.actor_id
    and chat_id=r.chat_id and target_chat_id=r.chat_id and assistant_message_id=r.assistant_id;
  delete from public.chat_requests where request_id='synthetic-wp4-retest' and actor_id=r.actor_id::text and chat_id=r.chat_id::text;
  delete from public.messages where actor_id=r.actor_id and chat_id=r.chat_id;
  delete from public.chats where id=r.chat_id and actor_id=r.actor_id;
  delete from public.actors where id=r.actor_id;
  update public.runpod_synthetic_validation set cleaned_at=now() where slot='wp4-retest';
end $$;
revoke all on function public.cleanup_runpod_synthetic_validation_retest() from public, anon, authenticated;
grant execute on function public.cleanup_runpod_synthetic_validation_retest() to service_role;
