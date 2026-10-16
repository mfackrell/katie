-- Additive visual sampled timelines. CLI unavailable; no historical backfill.
create table public.video_timeline_windows (
 actor_id uuid not null references public.actors(id) on delete cascade,
 source_chat_id uuid not null references public.chats(id) on delete cascade,
 attachment_id uuid not null,
 fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 version text not null check(length(version) between 1 and 100),
 requested_start double precision not null check(requested_start >= 0 and requested_start < 86400),
 requested_end double precision not null check(requested_end > requested_start and requested_end <= requested_start+30 and requested_end <= 86400),
 duration double precision check(duration > 0 and duration <= 86400),
 status text not null check(status in ('pending','processing','partial','complete','failed')),
 receipt uuid not null unique, attempts integer not null default 1 check(attempts=1),
 lease_until timestamptz not null default now()+interval '120 seconds',
 model text, frames jsonb, events jsonb, original_report text check(length(original_report)<=24000),
 failure text, created_at timestamptz not null default now(),
 primary key(source_chat_id,attachment_id,fingerprint,version,requested_start,requested_end)
);
alter table public.video_timeline_windows enable row level security;
revoke all on public.video_timeline_windows from public,anon,authenticated;
grant all on public.video_timeline_windows to service_role;
create trigger video_timeline_owner before insert or update on public.video_timeline_windows
 for each row execute function public.media_evidence_owner_guard();

-- All ownership locks are held through publication/deletion. No recovery ever
-- resubmits a processing/ambiguous receipt: external inference is not exactly once.
create function public.claim_video_timeline(p_actor uuid,p_current_chat uuid,p_source_chat uuid,p_attachment uuid,p_fingerprint text,p_version text,p_start double precision,p_end double precision,p_duration double precision,p_receipt uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare n integer;
begin
 perform 1 from public.chats where id=p_current_chat and actor_id=p_actor for share;
 if not found then raise exception 'Live request owner required'; end if;
 perform 1 from public.chats where id=p_source_chat and actor_id=p_actor for share;
 if not found then raise exception 'Live source owner required'; end if;
 if p_duration is null or p_end>p_duration then raise exception 'Trusted source duration required'; end if;
 insert into public.video_timeline_windows(actor_id,source_chat_id,attachment_id,fingerprint,version,requested_start,requested_end,duration,status,receipt)
 values(p_actor,p_source_chat,p_attachment,p_fingerprint,p_version,p_start,p_end,p_duration,'processing',p_receipt) on conflict do nothing;
 get diagnostics n=row_count;
 return n=1;
end $$;

create function public.read_video_timeline(p_actor uuid,p_current_chat uuid,p_source_chat uuid,p_attachment uuid,p_fingerprint text,p_version text,p_start double precision default 0,p_end double precision default 86400,p_offset integer default 0)
returns setof public.video_timeline_windows language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_start<0 or p_end<=p_start or p_end>86400 or p_offset<0 or p_offset>2880 then raise exception 'Invalid timeline range'; end if;
 perform 1 from public.chats where id=p_current_chat and actor_id=p_actor for share;
 if not found then raise exception 'Live request owner required'; end if;
 perform 1 from public.chats where id=p_source_chat and actor_id=p_actor for share;
 if not found then raise exception 'Live source owner required'; end if;
 return query select w.* from public.video_timeline_windows w
 where w.actor_id=p_actor and w.source_chat_id=p_source_chat and w.attachment_id=p_attachment and w.fingerprint=p_fingerprint and w.version=p_version
 and w.requested_end>=p_start and w.requested_start<=p_end order by w.requested_start,w.requested_end limit 100 offset p_offset;
end $$;

create function public.finish_video_timeline(p_actor uuid,p_current_chat uuid,p_source_chat uuid,p_attachment uuid,p_fingerprint text,p_version text,p_receipt uuid,p_model text,p_frames jsonb,p_events jsonb,p_report text,p_partial boolean,p_failure text,p_filename text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare w public.video_timeline_windows; e jsonb; frame_item jsonb; lo double precision; hi double precision;
begin
 perform 1 from public.chats where id=p_current_chat and actor_id=p_actor for share;
 if not found then raise exception 'Live request owner required'; end if;
 perform 1 from public.chats where id=p_source_chat and actor_id=p_actor for share;
 if not found then raise exception 'Live source owner required'; end if;
 select * into w from public.video_timeline_windows where actor_id=p_actor and source_chat_id=p_source_chat and attachment_id=p_attachment and fingerprint=p_fingerprint and version=p_version and receipt=p_receipt for update;
 if not found or w.status<>'processing' then return false; end if;
 if p_failure is null then
  if p_frames is null or p_events is null or p_report is null or p_partial is null or p_model is null or length(p_model)>200 or length(p_report) not between 1 and 24000 or jsonb_typeof(p_frames)<>'array' or jsonb_array_length(p_frames) not between 1 and 10 or jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events) not between 1 and 20 then raise exception 'Invalid timeline result'; end if;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_frames))<>jsonb_array_length(p_frames) then raise exception 'Duplicate frame identity'; end if;
  for frame_item in select value from jsonb_array_elements(p_frames) loop
   if frame_item->>'sha256' is null or length(frame_item->>'id') not between 1 and 90 or (frame_item->>'seconds')::double precision not between w.requested_start and w.requested_end or (frame_item->>'seconds') is null or (frame_item->>'sha256') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid frame evidence'; end if;
  end loop;
  for e in select value from jsonb_array_elements(p_events) loop
   if e->>'description' is null or e->'frame_ids' is null or jsonb_typeof(e->'frame_ids')<>'array' or length(e->>'description') not between 8 and 800 or jsonb_array_length(e->'frame_ids') not between 1 and 10 then raise exception 'Invalid event'; end if;
   if exists(select 1 from jsonb_array_elements_text(e->'frame_ids') i where not exists(select 1 from jsonb_array_elements(p_frames) f where f->>'id'=i)) then raise exception 'Foreign frame'; end if;
   select min((f->>'seconds')::double precision),max((f->>'seconds')::double precision) into lo,hi from jsonb_array_elements(p_frames) f where e->'frame_ids' ? (f->>'id');
   if lo is null or (e->>'observed_start')::double precision is distinct from lo or (e->>'observed_end')::double precision is distinct from hi then raise exception 'Invented event times'; end if;
  end loop;
 end if;
 update public.video_timeline_windows set status=case when p_failure is not null then 'failed' when p_partial then 'partial' else 'complete' end,
 model=p_model,frames=p_frames,events=p_events,original_report=p_report,failure=left(p_failure,200) where receipt=p_receipt and source_chat_id=p_source_chat and attachment_id=p_attachment;
 if p_failure is null then
  perform public.save_media_evidence(p_actor,p_source_chat,p_attachment,'analysis',p_version||':'||p_fingerprint||':'||w.requested_start||':'||w.requested_end,p_filename,'video/unknown','visual sampled events; gaps unknown',now(),true,p_events::text);
 end if;
 return true;
end $$;

revoke all on function public.claim_video_timeline(uuid,uuid,uuid,uuid,text,text,double precision,double precision,double precision,uuid) from public,anon,authenticated;
revoke all on function public.read_video_timeline(uuid,uuid,uuid,uuid,text,text,double precision,double precision,integer) from public,anon,authenticated;
revoke all on function public.finish_video_timeline(uuid,uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.claim_video_timeline(uuid,uuid,uuid,uuid,text,text,double precision,double precision,double precision,uuid) to service_role;
grant execute on function public.read_video_timeline(uuid,uuid,uuid,uuid,text,text,double precision,double precision,integer) to service_role;
grant execute on function public.finish_video_timeline(uuid,uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,text,boolean,text,text) to service_role;

-- Numeric filtering is on positive frame observations, including the final
-- frame, not on the enclosing window or an inferred continuous event span.
create function public.search_video_timeline_events(p_actor uuid,p_current_chat uuid,p_source_chat uuid,p_attachment uuid,p_fingerprint text,p_version text,p_start double precision,p_end double precision,p_query text default '',p_offset integer default 0)
returns table(description text,frame_ids jsonb,observed_start double precision,observed_end double precision,model text,window_status text)
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_start<0 or p_end<=p_start or p_end>86400 or p_start is null or p_end is null or length(p_query)>200 or p_query is null or p_offset<0 or p_offset>1000000 then raise exception 'Invalid event query'; end if;
 perform 1 from public.chats where id=p_current_chat and actor_id=p_actor for share;
 if not found then raise exception 'Live request owner required'; end if;
 perform 1 from public.chats where id=p_source_chat and actor_id=p_actor for share;
 if not found then raise exception 'Live source owner required'; end if;
 return query select e.value->>'description',s.ids,s.lo,s.hi,w.model,w.status
 from public.video_timeline_windows w cross join lateral jsonb_array_elements(w.events) e
 cross join lateral (
  select jsonb_agg(f.value->>'id' order by (f.value->>'seconds')::double precision) ids,
   min((f.value->>'seconds')::double precision) lo,max((f.value->>'seconds')::double precision) hi
  from jsonb_array_elements(w.frames) f where e.value->'frame_ids' ? (f.value->>'id')
   and (f.value->>'seconds')::double precision between p_start and p_end
 ) s
 where w.actor_id=p_actor and w.source_chat_id=p_source_chat and w.attachment_id=p_attachment and w.fingerprint=p_fingerprint and w.version=p_version and w.status in ('complete','partial')
 and s.lo is not null and (p_query='' or to_tsvector('english',e.value->>'description') @@ plainto_tsquery('english',p_query))
 order by s.lo,s.hi,w.requested_start,w.requested_end,e.value->>'description'
 limit 101 offset p_offset;
end $$;
revoke all on function public.search_video_timeline_events(uuid,uuid,uuid,uuid,text,text,double precision,double precision,text,integer) from public,anon,authenticated;
grant execute on function public.search_video_timeline_events(uuid,uuid,uuid,uuid,text,text,double precision,double precision,text,integer) to service_role;
