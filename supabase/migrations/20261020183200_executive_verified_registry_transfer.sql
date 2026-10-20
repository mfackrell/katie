-- Preserve historical delegations on the original Katie identity while giving
-- the dedicated Executive a separately owned registry of already verified specialists.
-- Copy only ACTIVE mission-backed contracts: no new capability is fabricated.
insert into public.executive_orchestrators
 (actor_id,slug,title,description,capabilities,adapter,endpoint_key,
  version,status,autonomy)
select eo.id,old.slug,old.title,old.description,old.capabilities,old.adapter,
       old.endpoint_key,old.version,old.status,old.autonomy
from public.executive_orchestrators old
cross join (select id from public.actors where actor_kind='executive' limit 1) eo
where old.actor_id<>eo.id and old.status='active' and old.adapter='mission'
on conflict (actor_id,slug) do nothing;
