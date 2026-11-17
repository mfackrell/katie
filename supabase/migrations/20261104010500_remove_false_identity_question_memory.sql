-- Single-target, owner-requested cleanup: a reflective question about Katie's
-- identity was incorrectly promoted to an authoritative LTM correction.
-- This is a one-time data repair, not a general memory cleanup.
-- Sole production writer: .github/workflows/migrate.yml.
begin;

do $cleanup$
declare
  target_actor constant uuid := 'f94eeb41-9bcd-4eb8-9896-bb92e5e3b5c0';
  target_chat constant uuid := '6e6a5c19-b747-4974-9dc7-890dacd13e03';
  target_source constant uuid := 'e95da1e7-2ff7-4118-84b9-cddf51c15f35';
  target_document constant uuid := '2925e841-bbfa-4939-8173-fc50933c26d3';
  source_id uuid;
  document_id uuid;
  document_content text;
  correction_key text;
  document_count integer;
  entry_count integer;
  after_count integer;
  original_count integer;
  deleted_count integer;
  before_record public.actor_long_term_memory%rowtype;
  retained_entries jsonb;
begin
  -- Fresh/disposable installations do not contain the production actor.
  if not exists (select 1 from public.actors where id=target_actor) then
    raise notice 'FALSE_IDENTITY_MEMORY_CLEANUP: target actor absent; no changes';
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'katie-false-identity-question-memory-20261104-v1',0));

  select * into before_record
    from public.actor_long_term_memory
    where actor_id=target_actor for update;
  if not found or jsonb_typeof(before_record.content->'entries') <> 'array' then
    raise exception 'FALSE_IDENTITY_MEMORY_CLEANUP: missing or invalid actor LTM';
  end if;
  original_count := jsonb_array_length(before_record.content->'entries');

  -- Source and document IDs were read from the production verification log
  -- for the 2026-11-04 00:49:21 UTC false-positive correction. Verify the
  -- chat, role, title and distinctive question text as independent evidence.
  select count(*) into document_count
  from public.actor_memory_documents d
  join public.messages m on m.id=d.source_message_id
  where d.id=target_document and d.source_message_id=target_source
    and m.id=target_source and d.actor_id=target_actor and m.actor_id=target_actor
    and m.chat_id=target_chat and m.role='user'
    and d.title='Authoritative correction to actor memory'
    and d.content like '%Katie, you said tonight''s experience permanently changed your understanding of yourself.%'
    and d.content like '%would you recognize that as a failure of memory%'
    and d.content like '%a genuine change in your understanding of who you are?';

  if document_count <> 1 then
    raise exception 'FALSE_IDENTITY_MEMORY_CLEANUP: expected exactly one source-linked document; found %',document_count;
  end if;

  select d.id,d.source_message_id,d.content
    into document_id,source_id,document_content
  from public.actor_memory_documents d
  join public.messages m on m.id=d.source_message_id
  where d.id=target_document and d.source_message_id=target_source
    and m.id=target_source and d.actor_id=target_actor and m.actor_id=target_actor
    and m.chat_id=target_chat and m.role='user'
    and d.title='Authoritative correction to actor memory'
    and d.content like '%Katie, you said tonight''s experience permanently changed your understanding of yourself.%'
    and d.content like '%would you recognize that as a failure of memory%'
    and d.content like '%a genuine change in your understanding of who you are?'
  for update of d;

  correction_key := 'correction.' || source_id::text;
  select count(*) into entry_count
    from jsonb_array_elements(before_record.content->'entries') e
    where e->>'key'=correction_key
      and e->>'value'=document_content
      and e->'evidenceMessageIds' @> to_jsonb(array[source_id::text]);

  if entry_count <> 1 then
    raise exception 'FALSE_IDENTITY_MEMORY_CLEANUP: exact LTM correction/evidence mismatch; found %',entry_count;
  end if;

  select coalesce(jsonb_agg(e.entry order by e.ordinal), '[]'::jsonb)
    into retained_entries
  from jsonb_array_elements(before_record.content->'entries')
    with ordinality as e(entry,ordinal)
  where e.entry->>'key' <> correction_key;

  if jsonb_array_length(retained_entries) <> original_count - 1 then
    raise exception 'FALSE_IDENTITY_MEMORY_CLEANUP: unexpected entry count after removal';
  end if;

  update public.actor_long_term_memory
    set content=jsonb_set(before_record.content,'{entries}',retained_entries,false),
        revision=before_record.revision+1,
        updated_at=now()
    where actor_id=target_actor and revision=before_record.revision;
  get diagnostics deleted_count=row_count;
  if deleted_count <> 1 then
    raise exception 'FALSE_IDENTITY_MEMORY_CLEANUP: revision compare-and-set failed';
  end if;

  delete from public.actor_memory_documents
    where id=document_id and actor_id=target_actor
      and source_message_id=source_id
      and content=document_content;
  get diagnostics deleted_count=row_count;
  if deleted_count <> 1 then
    raise exception 'FALSE_IDENTITY_MEMORY_CLEANUP: source document delete failed';
  end if;

  select count(*) into after_count
    from public.actor_long_term_memory l
    cross join lateral jsonb_array_elements(l.content->'entries') e
    where l.actor_id=target_actor and e->>'key'=correction_key;
  if after_count <> 0
     or exists (select 1 from public.actor_memory_documents where id=document_id)
     or not exists (select 1 from public.actor_long_term_memory
         where actor_id=target_actor
           and revision=before_record.revision+1
           and jsonb_array_length(content->'entries')=original_count-1) then
    raise exception 'FALSE_IDENTITY_MEMORY_CLEANUP: post-deletion verification failed';
  end if;

  -- The original messages, all other memories, STM, ITM, and accounting/audit
  -- records remain intact. No provider or external execution is involved.
  raise notice 'FALSE_IDENTITY_MEMORY_CLEANUP: exact LTM entry and source document removed; source_message_id=%',source_id;
end
$cleanup$;
commit;
