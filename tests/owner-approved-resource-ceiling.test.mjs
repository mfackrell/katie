import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync('supabase/migrations/20261023182000_owner_approved_resource_ceiling.sql','utf8');
test('budget guard preserves legacy ceiling but permits owner approved resource renewal',()=>{
 assert.match(sql,/token_allowance <= 10000000/);
 assert.match(sql,/token_allowance <= 600000 OR budget_authorization_source = 'user_approved'/);
 assert.doesNotMatch(sql,/update\s+work_projects/i);
});