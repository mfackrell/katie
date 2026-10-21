import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync('supabase/migrations/20261021215500_mission_advisory_wait_diagnostics.sql','utf8');

test('instrumentation preserves original global transaction lock and fails on changed function definition',()=>{
 assert.match(sql,/pg_advisory_xact_lock\(hashtextextended\(''katie\.mission\.state'',0\)\)/);
 assert.match(sql,/Expected unique advisory lock not found/);
 assert.match(sql,/FOREACH operation IN ARRAY/);
 assert.match(sql,/recover_game_specification_checkpoint/);
 assert.match(sql,/resume_game_checkpoint_watchdog/);
});
test('log payload has bounded non-sensitive operation and wait duration only',()=>{
 assert.match(sql,/p_operation NOT IN/);
 assert.match(sql,/elapsed_ms>=100/);
 assert.match(sql,/RAISE LOG 'katie_mission_lock_wait operation=% wait_ms=%'/);
 assert.match(sql,/REVOKE ALL ON FUNCTION .* FROM PUBLIC, anon, authenticated/);
});
