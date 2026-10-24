import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('prior approved resource request does not indefinitely suppress another',()=>{
 const code=readFileSync('lib/projects/recovery-budget.ts','utf8');
 assert.match(code,/latestApproval/);
 assert.match(code,/resource_authorization/);
 assert.match(code,/if\(pending\)return false/);
 assert.doesNotMatch(code,/if\(prior\?\.length\)return false/);
});
