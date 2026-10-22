import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync('supabase/migrations/20261022093000_separate_project_resource_estimates.sql','utf8');
const api=readFileSync('app/api/projects/route.ts','utf8');
test('estimate is advisory and is not tied to existing fixed project token ceiling',()=>{
 assert.match(sql,/estimated_tokens bigint/);
 assert.match(sql,/estimated_tokens IS NULL OR estimated_tokens > 0/);
 assert.match(sql,/p_tokens > 1000000000000/);
 assert.doesNotMatch(sql,/estimated_tokens\s*<=\s*token_allowance/);
});
test('estimate update never changes authorization, status, lease or operational watchdogs',()=>{
 const body=sql.split('CREATE OR REPLACE FUNCTION public.set_project_resource_estimate(')[1].split('END $fn$;')[0];
 assert.match(body,/UPDATE work_projects SET estimated_tokens=/);
 assert.doesNotMatch(body, /SET[^;]*token_allowance\s*=/i);
 assert.doesNotMatch(body, /SET[^;]*status\s*=/i);
 assert.match(body,/WHERE id=p_id AND actor_id=p_actor AND chat_id=p_chat FOR UPDATE/);
});
test('budget API reports forecast, authority and safeguards independently',()=>{
 assert.match(api,/estimatedTokens: p\.estimated_tokens/);
 assert.match(api,/authorizedTokens: p\.token_allowance/);
 assert.match(api,/safeguards: \{/);
});
