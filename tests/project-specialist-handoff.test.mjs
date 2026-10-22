import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync('supabase/migrations/20261022163000_project_specialist_estimates.sql','utf8');
test('specialist estimates require a matching reviewed mission and scoped source',()=>{
 assert.match(sql,/m.status<>'completed'/);
 assert.match(sql,/role='review' AND status='completed'/);
 assert.match(sql,/m.result::jsonb\)->'packages' IS DISTINCT FROM p_estimate->'packages'/);
 assert.match(sql,/p.approval_hash<>p_scope_hash/);
});
test('records are durable, idempotent and backend-only',()=>{
 assert.match(sql,/mission_id uuid NOT NULL UNIQUE/);
 assert.match(sql,/ON CONFLICT \(mission_id\) DO NOTHING/);
 assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
 assert.match(sql,/REVOKE ALL ON public.project_specialist_estimates FROM anon,authenticated,PUBLIC/);
});
