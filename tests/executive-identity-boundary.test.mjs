import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=(path)=>readFileSync(path,'utf8');

test('EO identity is database-owned and separate from ordinary Katie',()=>{
 const sql=read('supabase/migrations/20261020183000_executive_identity_boundary.sql');
 assert.match(sql,/actor_kind text not null default 'standard'/);
 assert.match(sql,/one_executive_actor/);
 assert.match(sql,/where not exists\(select 1 from public.actors where actor_kind='executive'\)/);
 const ui=read('components/specialist-directory.tsx');
 assert.match(ui,/actor\.actorKind === "executive"/);
 assert.doesNotMatch(ui,/actor\.name\.toLowerCase\(\) === "katie"/);
});
test('Executive commands use dedicated transport before all ordinary chat processing',()=>{
 const route=read('app/api/chat/route.ts');
 const idx=route.indexOf("if(actorRole.actor_kind==='executive')return runWithOrchestratorAccounting(()=>executeExecutiveCommand(payload,request))");
 assert.ok(idx>0);
 assert.ok(idx<route.indexOf("const task = await authorizeManagedChat"));
 assert.match(route,/const projectReply = !pdfProgress\.projectClarification && !executiveReply/);
 const transport=read('lib/executive/transport.ts');
 assert.match(transport,/handleExecutiveManagement\(/);
 assert.doesNotMatch(transport,/getAvailableProviders|assembleContext|runAdaptiveCollaboration/);
 const manager=read('lib/executive/management.ts');
 assert.match(manager,/identity\?\.actor_kind!=='executive'/);
 assert.match(manager,/startGeneralExecutiveManagement\(input\)/);
});
test('EO identity cannot be deleted through ordinary actor APIs',()=>{
 const api=read('app/api/actors/route.ts');
 assert.match(api,/Executive system identity cannot be deleted/);
 assert.match(api,/Cannot cascade-delete the Executive system identity/);
});
