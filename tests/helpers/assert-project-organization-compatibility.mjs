import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const providerMigration='supabase/migrations/20261110010000_provider_controlled_game_trial.sql';

export async function installHistoricalProviderModeSchema(db){
 // The frozen historical fixtures do not install the management migrations.
 // Use the deployed mode lookup and an empty authority table for legacy rows.
 const source=readFileSync(providerMigration,'utf8');
 const end=source.indexOf('create function public.project_provider_enable(');
 assert.ok(source.startsWith('begin;')&&end>0,'Provider lookup schema must precede activation');
 await db.query(source.slice('begin;'.length,end)+'revoke all on function public.project_provider_mode(uuid) from public,anon,authenticated,service_role; grant execute on function public.project_provider_mode(uuid) to service_role;');
}

export async function assertProjectOrganizationCompatibility(db,rival){
 await db.query('reset role');
 const snapshot=async()=>({
  projects:(await db.query("select to_jsonb(p)-'organization_version' row from work_projects p order by id")).rows,
  missions:(await db.query('select to_jsonb(m) row from agent_missions m order by id')).rows,
  accounts:(await db.query('select to_jsonb(a) row from benchmark_budget_accounts a order by id')).rows,
  calls:(await db.query('select to_jsonb(c) row from benchmark_budget_calls c order by id')).rows,
  exposures:(await db.query('select to_jsonb(e) row from benchmark_dollar_exposures e order by call_id')).rows,
 });
 const before=await snapshot();
 await db.query(readFileSync('supabase/migrations/20261109172739_project_management_hierarchy.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261109192013_functional_director_reporting.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261109204356_director_work_packages.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261109215345_smart_worker_admission.sql','utf8'));
 assert.deepEqual(await snapshot(),before,'Historical projects, missions, spending and claims remain unchanged');
 assert.equal((await db.query('select count(*)::int n from project_organization_nodes')).rows[0].n,before.projects.length);
 assert.equal((await db.query('select count(*)::int n from work_projects where organization_version<>0')).rows[0].n,0);
 // Exercise the installed canonical native admission and reconciliation stack,
 // including its new organization triggers, without synthetic replacement RPCs.
 await db.query('begin');
 await db.query(readFileSync('tests/sql/benchmark-native-gateway-real-postgres.sql','utf8'));
 await db.query('rollback');
 assert.deepEqual(await snapshot(),before);
 await rival.query('set role service_role');
 await assert.rejects(rival.query("update project_organization_nodes set kind='worker'"),/permission denied/);
 await db.query(readFileSync(providerMigration,'utf8'));
 assert.deepEqual(await snapshot(),before,'Provider-controlled mode must not alter historical data');
 await db.query(readFileSync('supabase/migrations/20261110180000_one_shot_director_recovery.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261110190600_director_recovery_cutoff_amendment.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261111001700_director_explicit_cutoff_window.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261111201431_provider_project_continuation.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261112020746_organizational_contract_amendments.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261112235000_existing_organization_scope_ratification.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261113182500_expired_hierarchical_authority_recovery.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261113210000_prework_hierarchy_delegation_priority.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261022234500_authorize_saved_project_resources.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261114170000_owner_scoped_mission_capacity_resume.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261114174000_scoped_root_retry_epoch.sql','utf8'));
 assert.deepEqual(await snapshot(),before,'Recovery migrations must preserve existing records');
 await (await import('./assert-project-scope-ratification.mjs')).assertProjectScopeRatification(db,rival);
 if(process.env.KATIE_TEST_DIRECTOR_ONE_SHOT==='1'){
  await (await import('./assert-director-one-shot-recovery.mjs')).assertDirectorOneShotRecovery(db,rival);
 }else{
  await (await import('./assert-provider-controlled-game-trial.mjs')).assertProviderControlledGameTrial(db,rival);
 }
 await (await import('./assert-project-native-delegation.mjs')).assertProjectNativeDelegation(db,rival);
 console.log('PROJECT_ORGANIZATION_COMBINED_SCHEMA_PASS: historical snapshots preserved; canonical native admission and settlement retained');
}
