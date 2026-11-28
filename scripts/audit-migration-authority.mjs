#!/usr/bin/env node
// Read-only migration provenance audit. Existing ledger rows are never changed.
// A single production migration writer uses this same preflight before applying
// anything. Native history is read-only evidence for explicitly mapped bytes.
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const catalogSQL="select p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_function_result(p.oid) result,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_sha,p.prosecdef definer,p.proconfig config,p.proacl::text acl,l.lanname language,pg_get_userbyid(p.proowner) owner,p.provolatile::text volatility,p.proisstrict strict,p.proleakproof leakproof,p.proparallel::text parallel,p.pronargdefaults defaults,pg_get_expr(p.proargdefaults,0) default_expr from pg_proc p join pg_language l on l.oid=p.prolang where p.pronamespace='public'::regnamespace and p.proname in ('standalone_admit','standalone_claim_dispatch','standalone_claim_workflow','standalone_finish_workflow','standalone_mark_uncertain') order by p.proname,pg_get_function_identity_arguments(p.oid)";
export const invariantSQL="select not exists(select 1 from pg_trigger where tgrelid='public.standalone_provider_attempts'::regclass and tgname='standalone_uncertainty_owner_limits') as uncertainty_trigger_absent, not exists(select 1 from public.standalone_provider_attempts a where a.state='paused' and a.pause_reason in ('thresholds_unset','per_call_threshold','request_threshold','selected_model_uncached','request_overrun','configuration_changed','request_exposure_changed') and a.cancelled_by_owner_at is null and not exists(select 1 from public.standalone_provider_attempts x where x.owner_id=a.owner_id and x.request_id=a.request_id and x.cancelled_by_owner_at is not null) and exists(select 1 from public.standalone_workflows w where w.owner_id=a.owner_id and w.request_id=a.request_id and w.status in ('pending','paused','running'))) as legacy_finance_pause_absent";
export const nativeSQL="select version,name,array_length(statements,1) as statement_count,encode(sha256(convert_to(array_to_string(statements,E'\\n'),'UTF8')),'hex') as sha256 from supabase_migrations.schema_migrations order by version";
function equalEvidence(a,b){
 const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
 return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
}
export function classifyMigrationHistory(expected,custom,native,manifest,catalog,invariants){
 const errors=[],applied=[],pending=[],unclassified=[];
 const customByName=new Map(custom.map(x=>[x.filename,x]));
 const nativeByVersion=new Map(native.map(x=>[x.version,x]));
 const mapping=new Map(manifest.native.map(x=>[x.filename,x]));
 const files=[...expected.keys()].sort();
 if(customByName.size!==custom.length||nativeByVersion.size!==native.length||mapping.size!==manifest.native.length||new Set(manifest.native.map(x=>x.version)).size!==manifest.native.length)errors.push("Duplicate migration provenance identity");
 for(const [filename,m] of mapping){
  if(!expected.has(filename))errors.push("Mapped historical repository file missing: "+filename);
  else if(expected.get(filename)!==m.sha256)errors.push("Mapped historical repository bytes changed: "+filename);
 }
 for(const filename of files){
  const sha256=expected.get(filename),old=customByName.get(filename),m=mapping.get(filename);
  if(old){
   if(old.checksum===sha256){applied.push({filename,source:"custom-ledger",sha256});continue;}
   const a=manifest.accounting;
   if(filename===a.filename&&old.checksum===a.recordedSha256&&sha256===a.repositorySha256&&old.applied_at===a.appliedAt&&a.historicalBytesRecovered===false&&equalEvidence(catalog,a.catalog)&&equalEvidence(invariants,a.invariants)&&a.catalog.length===5&&Object.values(a.invariants).every(v=>v===true)){
    applied.push({filename,source:"explicit-catalog-reconciliation",recordedSha256:old.checksum,repositorySha256:sha256,historicalBytesRecovered:false});continue;
   }
   errors.push("Historical migration checksum mismatch: "+filename);continue;
  }
  if(m){
   const n=nativeByVersion.get(m.version);
   if(n&&n.name===m.name&&n.statement_count===1&&m.statementCount===1&&n.sha256===sha256&&sha256===m.sha256){
    applied.push({filename,source:"exact-native-history",nativeVersion:n.version,sha256});continue;
   }
   errors.push("Historical native migration provenance mismatch: "+filename);continue;
  }
  unclassified.push(filename);
 }
 const newest=[...applied.map(x=>x.filename),...custom.map(x=>x.filename)].sort().at(-1);
 for(const filename of unclassified){
  if(newest&&filename<=newest)errors.push("Unproven historical migration; do not replay: "+filename);
  else pending.push(filename);
 }
 return {applied,pending,errors,historicalOnly:custom.filter(x=>!expected.has(x.filename)).map(x=>x.filename)};
}
function readRows(url,sql){
 for(let attempt=0;attempt<3;attempt++){
  const p=spawnSync('psql',[url,'-t','-A','-v','ON_ERROR_STOP=1','-c',`select coalesce(json_agg(t),'[]'::json) from (${sql}) t`],{encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});
  if(p.status===0)return JSON.parse(p.stdout.trim());
  if(attempt===2||!/authentication did not complete|authentication timeout|connection timed out|could not connect|connection terminated/i.test(p.stderr??''))throw Error('Migration history query failed: '+(p.stderr||p.error?.message||'unknown').slice(0,500));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400*(attempt+1));
 }
}
export function auditMigrationPlan(url,dir=join(process.cwd(),'supabase','migrations')){
 if(!url)throw Error('DATABASE_URL required');
 const manifest=JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),'migration-provenance.json'),'utf8'));
 const files=readdirSync(dir).filter(x=>x.endsWith('.sql')).sort();
 const expected=new Map(files.map(filename=>[filename,createHash('sha256').update(readFileSync(join(dir,filename))).digest('hex')]));
 const custom=readRows(url,"select filename,checksum, to_char(applied_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US')||'+00:00' applied_at from public.schema_migrations order by filename");
 const native=readRows(url,nativeSQL);
 const row=custom.find(x=>x.filename===manifest.accounting.filename);
 const knownMismatch=row?.checksum===manifest.accounting.recordedSha256&&expected.get(manifest.accounting.filename)===manifest.accounting.repositorySha256;
 const plan=classifyMigrationHistory(expected,custom,native,manifest,knownMismatch?readRows(url,catalogSQL):null,knownMismatch?readRows(url,invariantSQL)[0]:null);
 return {...plan,repoFiles:files.length,customEntries:custom.length,nativeEntries:native.length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const plan=auditMigrationPlan(process.env.DATABASE_URL);
  console.log(JSON.stringify({authority:'public.schema_migrations via migrate.yml; verified native historical bytes read-only',...plan},null,2));
  if(plan.errors.length){console.error('Unresolved migration provenance; refuse deployment.');process.exitCode=1;}
 }catch(error){console.error(error.message);process.exitCode=1;}
}
