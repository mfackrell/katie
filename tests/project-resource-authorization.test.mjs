import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('supabase/migrations/20261022234500_authorize_saved_project_resources.sql','utf8');
test('resource authorization is service-only, scoped and auditable',()=>{
 assert.match(source,/p_id=p_id and actor_id=p_actor and chat_id=p_chat/);
 assert.match(source,/p\.token_allowance is distinct from p_expected_allowance/);
 assert.match(source,/p_approval_ref is null/);
 assert.match(source,/event='resource_authorization'/);
 assert.match(source,/approvalRef/);
 assert.match(source,/revoke all on function public\.authorize_work_project_resources/);
 assert.match(source,/grant execute on function public\.authorize_work_project_resources[\s\S]*to service_role/);
});
test('renewal never resets spent tokens, project status, or approval',()=>{
 assert.match(source,/sum\(greatest\(actual_tokens,reserved_tokens\)\)/);
 assert.match(source,/p_authorized_allowance <= p.token_allowance/);
 assert.match(source,/p_max_missions <= p.max_missions/);
 assert.match(source,/p_deadline <= greatest\(p.deadline/);
 assert.match(source,/Cannot renew resources while a project mission is active/);
 const write=source.slice(source.indexOf('update work_projects set'),source.indexOf('insert into project_events(project_id,event,data) values('));
 for(const forbidden of ['status=','actual_tokens=','reserved_tokens=','approval_hash=','approved_hash=','phase=','active_mission_id='])assert.equal(write.includes(forbidden),false,forbidden);
});
