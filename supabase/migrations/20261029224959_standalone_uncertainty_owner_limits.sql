-- Reuse the durable exposure authorization ledger under the owner's existing limits.
begin;
create function public.standalone_auto_authorize_uncertain_exposure(p_owner uuid,p_attempt uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts;exposure numeric;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state<>'uncertain' or a.cancelled_by_owner_at is not null or not standalone_verify_scope(p_owner,a.actor_id,a.chat_id) then return false;end if;
 if standalone_uncertain_exposure_accepted(p_owner,p_attempt) then return true;end if;
 -- Already includes this reservation once, plus every supporting call for the original request.
 exposure:=standalone_request_committed(p_owner,a.request_id);
 if c.per_call_limit_microusd is null or c.request_limit_microusd is null
 or a.reserved_microusd>c.per_call_limit_microusd or exposure>c.request_limit_microusd then return false;end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and (actual_microusd>reserved_microusd or cancelled_by_owner_at is not null)) then return false;end if;
 if not exists(select 1 from standalone_workflows where owner_id=p_owner and request_id=a.request_id and actor_id=a.actor_id and chat_id=a.chat_id) then return false;end if;
 perform standalone_accept_uncertain_exposure(p_owner,a.id,c.budget_revision,a.reserved_microusd);
 insert into standalone_attempt_events(attempt_id,owner_id,kind,details) values(a.id,p_owner,'uncertain_exposure_auto_authorized',jsonb_build_object('authorization','existing_owner_cost_limits','request_id',a.request_id,'reserved_microusd',a.reserved_microusd::text,'request_exposure_microusd',exposure::text,'budget_revision',c.budget_revision));
 return true;
end $$;
create or replace function public.standalone_mark_uncertain(p_owner uuid,p_attempt uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found then raise exception 'STANDALONE_ATTEMPT_NOT_FOUND';end if;
 if a.state in('dispatched','uncertain') then
 update standalone_provider_attempts set state='uncertain',uncertainty_reason=p_reason where id=a.id returning * into a;
 perform standalone_auto_authorize_uncertain_exposure(p_owner,a.id);
 elsif a.state<>'settled' then raise exception 'STANDALONE_NOT_DISPATCHED';end if;
 return standalone_attempt_json(a);
end $$;
revoke all on function public.standalone_auto_authorize_uncertain_exposure(uuid,uuid) from public,anon,authenticated;
grant execute on function public.standalone_auto_authorize_uncertain_exposure(uuid,uuid) to service_role;
-- Existing paused original requests receive the same durable policy decision.
-- Completed history is accounting-only and is not restarted.
do $$ declare a record;begin
 for a in select p.owner_id,p.id from standalone_provider_attempts p join standalone_workflows w
 on w.owner_id=p.owner_id and w.request_id=p.request_id where p.state='uncertain' and w.status='paused' and p.cancelled_by_owner_at is null
 loop perform standalone_auto_authorize_uncertain_exposure(a.owner_id,a.id);end loop;
end $$;
commit;
