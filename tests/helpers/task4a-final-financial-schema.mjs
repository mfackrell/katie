// Disposable PostgreSQL only. Upgrade the lightweight project fixture and load
// production admission bodies verbatim; no financial admission mocks.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const migration=readFileSync('supabase/migrations/20261101160000_ordinary_developer_authority.sql','utf8');
function productionFunction(name,source=migration){
 const match=new RegExp('create (?:or replace )?function (?:public\\.)?'+name+'\\(').exec(source);
 const start=match?.index??-1;
 assert.ok(start>=0,'Production function missing: '+name);
 const body=source.indexOf('as $$',start);
 const end=source.indexOf('$$;',body+5);
 assert.ok(body>start&&end>body,'Production body missing: '+name);
 return source.slice(start,end+3).replace(/^create function/,'create or replace function');
}
// Invoke before seeding the historical ledger; no admission triggers installed
// until fixture restoration is finished.
export async function prepareTask4aFinalFinancialSchema(db){
 await db.query(`alter table benchmark_budget_calls add column if not exists continuation_id uuid,
  add column if not exists provider_namespace text,
  add column if not exists pricing_snapshot jsonb,
  add column if not exists provider_receipt_at timestamptz;
 alter table benchmark_dollar_exposures
  add column if not exists reserved_microusd numeric,
  add column if not exists price_per_million numeric,
  add column if not exists basis text,
  add column if not exists price_evidence jsonb;
 create unique index if not exists task4a_final_exposure_call_unique on benchmark_dollar_exposures(call_id);
 create unique index if not exists task4a_final_canonical_request_unique on benchmark_budget_calls(account_id,request_key);
 create unique index if not exists task4a_final_legacy_projection_unique on benchmark_budget_calls(legacy_mission_call_id) where legacy_mission_call_id is not null;
 grant all on benchmark_dollar_exposures to service_role;`);
}
// Invoke AFTER historical seed/trigger restoration and BEFORE final-successor
// migration. Existing Task4A project guards and grant predicates stay installed.
export async function installTask4aFinalFinancialAdmission(db){
 // The lightweight fixture named its argument differently; PostgreSQL does not
 // allow changing input argument names with CREATE OR REPLACE.
 await db.query('drop function developer_validate_limits(jsonb)');
 for(const name of ['developer_validate_limits','developer_current_mission_authority','developer_native_reserve','developer_dollar_admission','developer_mission_projection_required']){
  await db.query(productionFunction(name));
 }
 for(const file of ['20261024230000_benchmark_atomic_mission_settlement.sql','20261025184500_benchmark_linked_settlement_guards.sql','20261025185500_benchmark_atomic_linked_receipts.sql','20261028132000_benchmark_provider_usage_evidence.sql']){
  await db.query(readFileSync('supabase/migrations/'+file,'utf8'));
 }
 await db.query(productionFunction('benchmark_dollar_settlement',readFileSync('supabase/migrations/20261030143925_benchmark_cumulative_execution_controls.sql','utf8')));
 await db.query(`drop trigger if exists developer_dollar_admission on benchmark_budget_calls;
 create trigger developer_dollar_admission after insert on benchmark_budget_calls
  for each row execute function developer_dollar_admission();
 drop trigger if exists developer_mission_projection_required on mission_calls;
 create constraint trigger developer_mission_projection_required after insert on mission_calls
  deferrable initially deferred for each row execute function developer_mission_projection_required();
 drop trigger if exists benchmark_dollar_settlement on benchmark_budget_calls;
 create trigger benchmark_dollar_settlement after update on benchmark_budget_calls
  for each row execute function benchmark_dollar_settlement();
 revoke all on function developer_native_reserve(text,uuid,bigint,text,text,bigint) from public,anon,authenticated;
 grant execute on function developer_native_reserve(text,uuid,bigint,text,text,bigint) to service_role;`);
 for(const name of ['developer_native_reserve','developer_dollar_admission']){
  const result=await db.query('select prosrc from pg_proc where proname=$1 and pronamespace=\'public\'::regnamespace',[name]);
  const body=productionFunction(name).split('as $$')[1].split('$$;')[0];
  assert.equal(result.rows.length,1,'Unambiguous production financial function');
  assert.equal(result.rows[0].prosrc,body,'Database runs exact production financial body');
 }
}
