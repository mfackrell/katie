import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
 console.log('PROJECT_ORGANIZATION_COMBINED_SCHEMA_PASS: historical snapshots preserved; canonical native admission and settlement retained');
}
