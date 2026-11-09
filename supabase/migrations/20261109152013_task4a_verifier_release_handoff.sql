-- Separate, append-only release consent for the already-authorized failed verifier.
-- No old receipt, deadline, financial allowance, claim or postpaid handoff is changed.
alter function public.task4a_verifier_execution_proposal(text,text) rename to task4a_verifier_execution_proposal_before_handoff;

create function public.task4a_verifier_handoff_evidence(p_release text,p_evidence jsonb)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare finance project_events;receipt project_events;offer jsonb;proposal jsonb;receipts jsonb;action text;
 old_release constant text:='6b70a8fd2c48c388356b5ef371c51cb096c8a853';
begin
 if p_release is null or p_release !~ '^[a-f0-9]{40}$' or p_release=old_release
 or p_evidence->>'releaseSha' is distinct from p_release
 or p_evidence->>'version' is distinct from 'task4a-verifier-qualified-release-v1'
 or p_evidence->>'repository' is distinct from 'mfackrell/katie'
 or p_evidence->>'baselineSha' is distinct from 'cff4c7c2ea175ef1f9752f64a0cf2e023c8eecd3'
 or coalesce(p_evidence->>'treeSha','') !~ '^[a-f0-9]{40}$'
 or coalesce(p_evidence->>'qualifiedHeadSha','') !~ '^[a-f0-9]{40}$'
 or coalesce(p_evidence->>'pullRequest','') !~ '^[1-9][0-9]*$'
 or jsonb_typeof(p_evidence->'checks') is distinct from 'array' or jsonb_array_length(p_evidence->'checks')<>4
 then return jsonb_build_object('ready',false,'reason','qualified_release_evidence_unavailable');end if;
 -- IDs authenticate the original immutable rows; canonical hashes and the
 -- unchanged planner authenticate their contents against the live authority.
 select * into finance from project_events where id='b31d5fbf-e4bd-4404-8509-578fe5957b3d'
 and project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' and event='task4a_verifier_owner_authorized';
 if finance.id is null or finance.data->>'consentDigest' is distinct from encode(sha256(convert_to(project_canonical(finance.data->'proposal'),'UTF8')),'hex')
 or finance.data->'proposal'->>'releaseSha' is distinct from old_release
 or finance.data->'proposal'->'checkpoint'->>'checkpointSha' is distinct from '1d51f2fa7f95fec1cb8c777c0525402e05f34f8e'
 or finance.data->'proposal'->'checkpoint'->>'sourceTreeSha' is distinct from '26869fb977fd29b4f96652b9de3d47e0f0e0ffeb'
 then return jsonb_build_object('ready',false,'reason','historical_authority_unavailable');end if;
 receipts:=jsonb_build_array(jsonb_build_object('id',finance.id,'event',finance.event,'digest',finance.data->>'consentDigest'));
 foreach action in array array['replacement','inference'] loop
 offer:=task4a_verifier_execution_proposal_before_handoff(old_release,action);
 select * into receipt from project_events where project_id=finance.project_id
 and id=case action when 'replacement' then 'b4c70553-b3db-40d0-b660-4584709e0945'::uuid else 'ce6c1d21-791b-4a10-95ea-1c2f1e783327'::uuid end
 and event=case action when 'replacement' then 'task4a_verifier_execution_authorized' else 'task4a_verifier_inference_authorized' end;
 if offer->>'ready' is distinct from 'true' or receipt.id is null
 or receipt.data->>'consentDigest' is distinct from offer->>'digest' or receipt.data->'proposal' is distinct from offer->'proposal'
 or receipt.data->>'ownerId' is distinct from offer->'proposal'->>'ownerId'
 or finance.data->'result'->>'deadline' is distinct from offer->'proposal'->>'deadline'
 then return jsonb_build_object('ready',false,'reason','historical_execution_authority_unavailable');end if;
 receipts:=receipts||jsonb_build_array(jsonb_build_object('id',receipt.id,'event',receipt.event,'digest',receipt.data->>'consentDigest'));
 end loop;
 proposal:=jsonb_build_object('version','task4a-verifier-release-handoff-v1','action','handoff','ownerId',offer->'proposal'->>'ownerId',
 'approvalId',offer->'proposal'->>'approvalId','projectId',finance.project_id,'taskId',offer->'proposal'->>'taskId',
 'sourceReleaseSha',old_release,'releaseSha',p_release,'releaseEvidence',p_evidence,'receipts',receipts,
 'checkpoint',offer->'proposal'->'checkpoint','deadline',offer->'proposal'->'deadline','envelope',offer->'proposal'->'envelope',
 'additionalTokens',0,'additionalCalls',0,'additionalMicrousd',0,'deadlineRenewed',false,
 'dispatchAuthorized',false,'newPaidGrant',false,'freshDispatchConsentRequired',true);
 return jsonb_build_object('ready',true,'proposal',proposal,'digest',encode(sha256(convert_to(project_canonical(proposal),'UTF8')),'hex'));
end $$;

create function public.task4a_verifier_handoff_proposal(p_release text,p_evidence jsonb)
returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 if exists(select 1 from project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'
 and event in ('task4a_verifier_release_handoff_authorized','task4a_verifier_dispatch_authorized','task4a_verifier_execution_claimed'))
 then return jsonb_build_object('ready',false,'reason','handoff_already_used_or_dispatch_recorded');end if;
 return task4a_verifier_handoff_evidence(p_release,p_evidence);
end $$;
create function public.task4a_verifier_handoff_authorize(p_owner uuid,p_digest text,p_release text,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare offer jsonb;receipt uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 offer:=task4a_verifier_handoff_proposal(p_release,p_evidence);
 if p_owner is null or offer->>'ready' is distinct from 'true' or offer->>'digest' is distinct from p_digest
 or offer->'proposal'->>'ownerId' is distinct from p_owner::text then raise exception 'TASK4A_VERIFIER_HANDOFF_CONSENT_DENIED';end if;
 insert into project_events(project_id,event,data) values('6d1c29f1-b31e-47a5-aabb-cbcf1326f388','task4a_verifier_release_handoff_authorized',
 jsonb_build_object('ownerId',p_owner,'consentDigest',p_digest,'proposal',offer->'proposal')) returning id into receipt;
 return jsonb_build_object('authorized',true,'receiptId',receipt,'dispatched',false,'newPaidCalls',0,'deadlineRenewed',false);
end $$;
create function public.task4a_verifier_handoff_valid(p_release text)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare receipt project_events;offer jsonb;
begin
 select * into receipt from project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' and event='task4a_verifier_release_handoff_authorized';
 if receipt.id is null then return false;end if;
 offer:=task4a_verifier_handoff_evidence(p_release,receipt.data->'proposal'->'releaseEvidence');
 return coalesce(offer->>'ready'='true' and receipt.data->>'consentDigest'=offer->>'digest'
 and receipt.data->'proposal'=offer->'proposal' and receipt.data->>'ownerId'=offer->'proposal'->>'ownerId',false);
end $$;
create function public.task4a_verifier_execution_proposal(p_release text,p_action text default 'replacement')
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare receipt project_events;offer jsonb;proposal jsonb;
begin
 select * into receipt from project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' and event='task4a_verifier_release_handoff_authorized';
 if receipt.id is null then return task4a_verifier_execution_proposal_before_handoff(p_release,p_action);end if;
 if not task4a_verifier_handoff_valid(p_release) then return jsonb_build_object('ready',false,'reason','release_handoff_required_or_invalid');end if;
 offer:=task4a_verifier_execution_proposal_before_handoff(receipt.data->'proposal'->>'sourceReleaseSha',p_action);
 -- Preserve the original replacement/inference offers byte-for-byte. Only the
 -- still-unconsumed dispatch decision binds the new release and handoff receipt.
 if p_action<>'dispatch' or offer->>'ready' is distinct from 'true' then return offer;end if;
 proposal:=offer->'proposal'||jsonb_build_object('version','task4a-verifier-handoff-dispatch-v1','releaseSha',p_release,
 'handoffReceiptId',receipt.id,'handoffConsentDigest',receipt.data->>'consentDigest');
 return jsonb_build_object('ready',true,'proposal',proposal,'digest',encode(sha256(convert_to(project_canonical(proposal),'UTF8')),'hex'));
end $$;
create unique index task4a_verifier_one_release_handoff on public.project_events(project_id,event)
 where event='task4a_verifier_release_handoff_authorized';
create function public.task4a_verifier_handoff_immutable() returns trigger language plpgsql set search_path=public as $$
begin
 if old.event='task4a_verifier_release_handoff_authorized' or (tg_op='UPDATE' and new.event='task4a_verifier_release_handoff_authorized')
 then raise exception 'TASK4A_VERIFIER_HANDOFF_IMMUTABLE';end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger task4a_verifier_handoff_immutable before update or delete on public.project_events
 for each row execute function public.task4a_verifier_handoff_immutable();
-- GitHub qualification evidence is supplied only by the authenticated server,
-- never accepted from client JSON. All internal adapters remain non-RPC helpers.
do $$ declare r record;begin
 for r in select oid::regprocedure sig,proname from pg_proc where pronamespace='public'::regnamespace and
 (proname like 'task4a_verifier_handoff_%' or proname in ('task4a_verifier_execution_proposal','task4a_verifier_execution_proposal_before_handoff')) loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',r.sig);
 if r.proname in ('task4a_verifier_handoff_proposal','task4a_verifier_handoff_authorize','task4a_verifier_execution_proposal') then execute format('grant execute on function %s to service_role',r.sig);end if;
 end loop;
end $$;
