begin;

-- Owner-supplied recovery deadlines may span a day. The existing single-use
-- receipt, exact prior cutoff, owner/release checks and Director deadline remain
-- authoritative. Installation alone admits no recovery.
do $migration$
declare body text; step record;
begin
 body:=pg_get_functiondef('public.project_admit_expired_director_recovery(uuid,uuid,text,timestamptz,timestamptz)'::regprocedure);
 for step in select * from (values
  ($old$p_cutoff>checked_at+interval '2 hours'$old$,$new$p_cutoff>checked_at+interval '24 hours'$new$),
  ($old$Exact expired cutoff and a future recovery cutoff within two hours required$old$,
   $new$Exact expired cutoff and a future recovery cutoff within twenty-four hours required$new$)
 ) as patches(original,replacement) loop
  if (length(body)-length(replace(body,step.original,'')))/length(step.original)<>1
  then raise exception 'Unexpected installed Director cutoff admission definition';end if;
  body:=replace(body,step.original,step.replacement);
 end loop;
 execute body;
end $migration$;

commit;
