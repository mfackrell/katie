-- Append-only M1. Supabase CLI unavailable in implementation environment.
create table public.media_evidence (
 actor_id uuid not null references public.actors(id) on delete cascade,
 source_chat_id uuid not null references public.chats(id) on delete cascade,
 attachment_id uuid not null,
 kind text not null check (kind in ('discovery','extracted','analysis','timing')),
 version text not null check (length(version) between 1 and 512),
 filename text not null, mime_type text not null, coverage text not null,
 created_at timestamptz not null, original_available boolean,
 chunk_index integer not null check(chunk_index >= 0),
 start_offset integer not null check(start_offset >= 0),
 body text not null check(length(body) <= 4000),
 search_vector tsvector generated always as (to_tsvector('english', body || ' ' || filename)) stored,
 primary key(source_chat_id,attachment_id,kind,version,chunk_index)
);
create index media_evidence_search on public.media_evidence using gin(search_vector);
alter table public.media_evidence enable row level security;
revoke all on public.media_evidence from public, anon, authenticated;
grant all on public.media_evidence to service_role;

create function public.media_evidence_owner_guard() returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
 perform 1 from public.chats where id = new.source_chat_id and actor_id = new.actor_id for share;
 if not found then raise exception 'Live source owner required'; end if;
 return new;
end $$;
revoke all on function public.media_evidence_owner_guard() from public, anon, authenticated;
grant execute on function public.media_evidence_owner_guard() to service_role;
create trigger media_evidence_owner before insert or update on public.media_evidence for each row execute function public.media_evidence_owner_guard();

create function public.save_media_evidence(p_actor uuid,p_chat uuid,p_attachment uuid,p_kind text,p_version text,p_filename text,p_mime text,p_coverage text,p_created timestamptz,p_original boolean,p_text text)
returns void language plpgsql security invoker set search_path = public, pg_temp as $$
begin
 if length(p_filename)>255 or length(p_mime)>128 or length(p_coverage)>512 then raise exception 'Invalid evidence metadata'; end if;
 if length(p_text)>10000000 then raise exception 'Evidence too large'; end if;
 perform 1 from public.chats where id=p_chat and actor_id=p_actor for share;
 if not found then raise exception 'Live source owner required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_chat::text || p_attachment::text || p_kind || p_version,0));
 delete from public.media_evidence where source_chat_id=p_chat and attachment_id=p_attachment and kind=p_kind and version=p_version;
 insert into public.media_evidence(actor_id,source_chat_id,attachment_id,kind,version,filename,mime_type,coverage,created_at,original_available,chunk_index,start_offset,body)
 select p_actor,p_chat,p_attachment,p_kind,p_version,p_filename,p_mime,p_coverage,p_created,p_original,n/3600,n,substring(p_text from n+1 for 4000)
 from generate_series(0,length(p_text)-1,3600) n;
end $$;
revoke all on function public.save_media_evidence(uuid,uuid,uuid,text,text,text,text,text,timestamptz,boolean,text) from public,anon,authenticated;
grant execute on function public.save_media_evidence(uuid,uuid,uuid,text,text,text,text,text,timestamptz,boolean,text) to service_role;

create function public.search_media_evidence(p_actor uuid,p_current_chat uuid,p_query text,p_mime text default null,p_after timestamptz default null,p_before timestamptz default null)
returns setof public.media_evidence language plpgsql security invoker set search_path = public, pg_temp as $$
begin
 if length(p_mime)>128 then raise exception 'Invalid type filter'; end if;
 if length(p_query)>500 or length(p_query)<1 then raise exception 'Invalid query'; end if;
 perform 1 from public.chats where id=p_current_chat and actor_id=p_actor for share;
 if not found then raise exception 'Live request owner required'; end if;
 return query select e.* from public.media_evidence e join public.chats c on c.id=e.source_chat_id and c.actor_id=p_actor
 where e.actor_id=p_actor and e.search_vector @@ websearch_to_tsquery('english',p_query)
 and (p_mime is null or
 (p_mime='spreadsheet' and e.mime_type ~ '(spreadsheet|excel|csv|opendocument.spreadsheet)') or
 (p_mime='document' and e.mime_type !~ '^(image|video)/' and e.mime_type !~ '(spreadsheet|excel|csv)') or
 (p_mime not in ('spreadsheet','document') and e.mime_type like p_mime))
 and (p_after is null or e.created_at>=p_after) and (p_before is null or e.created_at<p_before)
 order by (e.source_chat_id=p_current_chat) desc,ts_rank_cd(e.search_vector,websearch_to_tsquery('english',p_query)) desc,e.source_chat_id,e.attachment_id,e.chunk_index limit 12;
end $$;
revoke all on function public.search_media_evidence(uuid,uuid,text,text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.search_media_evidence(uuid,uuid,text,text,timestamptz,timestamptz) to service_role;

-- Existing operational rows remain untouched. Only already registered, live sources qualify.
create function public.reconcile_media_video(p_actor uuid,p_current_chat uuid) returns integer
language plpgsql security invoker set search_path=public,pg_temp as $$
declare j record; f record; total integer:=0;
begin
 perform 1 from public.chats where id=p_current_chat and actor_id=p_actor for share;
 if not found then raise exception 'Live request owner required'; end if;
 for j in select v.* from public.video_analysis_jobs v
 join public.chats c on c.id=v.chat_id and c.actor_id=p_actor
 where v.actor_id=p_actor and v.attachment_path ~ ('^chats/'||v.chat_id::text||'/[0-9a-f-]{36}\.source$')
 and exists(select 1 from public.media_evidence e where e.source_chat_id=v.chat_id and e.attachment_id=split_part(split_part(v.attachment_path,'/',3),'.',1)::uuid)
 and ((v.status='completed' and length(v.analysis_text)>=25 and v.analysis_text !~* '^(I (cannot|can.t|am unable)|sorry|as an AI)' and not exists(select 1 from public.media_evidence e where e.version='job:'||v.id||':'||v.model||':'||md5(v.analysis_text)))
 or (v.fallback_state='completed' and length(v.fallback_text)>=25 and v.fallback_text !~* '^(I (cannot|can.t|am unable)|sorry|as an AI)' and not exists(select 1 from public.media_evidence e where e.version='job:'||v.id||':'||coalesce(v.fallback_model,'unknown-model')||':'||md5(v.fallback_text))))
 order by v.submitted_at limit 3
 loop
 select * into f from public.media_evidence e where e.source_chat_id=j.chat_id and e.attachment_id=split_part(split_part(j.attachment_path,'/',3),'.',1)::uuid limit 1;
 if j.status='completed' and length(j.analysis_text)>=25 and j.analysis_text !~* '^(I (cannot|can.t|am unable)|sorry|as an AI)' then
 perform public.save_media_evidence(p_actor,j.chat_id,f.attachment_id,'analysis','job:'||j.id||':'||j.model||':'||md5(j.analysis_text),f.filename,f.mime_type,'model report; original-video coverage unknown',f.created_at,f.original_available,j.analysis_text);
 end if;
 if j.fallback_state='completed' and length(j.fallback_text)>=25 and j.fallback_text !~* '^(I (cannot|can.t|am unable)|sorry|as an AI)' then
 perform public.save_media_evidence(p_actor,j.chat_id,f.attachment_id,'analysis','job:'||j.id||':'||coalesce(j.fallback_model,'unknown-model')||':'||md5(j.fallback_text),f.filename,f.mime_type,'sampled frames; supplied Qwen report; not independent confirmation',f.created_at,f.original_available,j.fallback_text);
 end if;
 total:=total+1;
 end loop;
 return total;
end $$;
revoke all on function public.reconcile_media_video(uuid,uuid) from public,anon,authenticated;
grant execute on function public.reconcile_media_video(uuid,uuid) to service_role;

create function public.index_completed_media_video() returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if new.actor_id is not null and new.chat_id is not null and
 (new.status='completed' or new.fallback_state='completed') then
   begin
     perform public.reconcile_media_video(new.actor_id,new.chat_id);
   exception when others then
     -- Canonical operational evidence is already saved; bounded reconciliation retries later.
     raise warning 'Saved media indexing deferred';
   end;
 end if;
 return new;
end $$;
revoke all on function public.index_completed_media_video() from public,anon,authenticated;
grant execute on function public.index_completed_media_video() to service_role;
create trigger index_completed_media_video after insert or update of status,analysis_text,fallback_state,fallback_text on public.video_analysis_jobs for each row execute function public.index_completed_media_video();

create function public.read_media_evidence(p_actor uuid,p_current_chat uuid,p_source_chat uuid,p_attachment uuid,p_kind text,p_version text,p_offset integer)
returns setof public.media_evidence language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_offset<0 or p_offset>10000000 or length(p_version)>512 then raise exception 'Invalid evidence location'; end if;
 perform 1 from public.chats where id=p_current_chat and actor_id=p_actor for share;
 if not found then raise exception 'Live request owner required'; end if;
 return query select e.* from public.media_evidence e join public.chats c on c.id=e.source_chat_id and c.actor_id=p_actor
 where e.actor_id=p_actor and e.source_chat_id=p_source_chat and e.attachment_id=p_attachment and e.kind=p_kind and e.version=p_version and e.start_offset+length(e.body)>p_offset
 order by e.start_offset limit 4;
end $$;
revoke all on function public.read_media_evidence(uuid,uuid,uuid,uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.read_media_evidence(uuid,uuid,uuid,uuid,text,text,integer) to service_role;
