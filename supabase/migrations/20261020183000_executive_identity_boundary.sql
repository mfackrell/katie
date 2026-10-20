-- Executive is a distinct system identity, never inferred from an actor's display name.
alter table public.actors add column if not exists actor_kind text not null default 'standard';
alter table public.actors drop constraint if exists actors_actor_kind_check;
alter table public.actors add constraint actors_actor_kind_check check (actor_kind in ('standard','executive'));
create unique index if not exists one_executive_actor on public.actors(actor_kind) where actor_kind='executive';
insert into public.actors (name,system_prompt,actor_kind,review_mode)
select 'Executive Orchestrator',
       'Management-only executive. Interpret objectives, commission qualified autonomous specialist orchestrators, delegate, monitor, validate and report. Never personally execute specialist work or substitute a chatbot answer for a durable mission. Report missing capabilities or blocked assignments explicitly.',
       'executive','always'
where not exists(select 1 from public.actors where actor_kind='executive');
