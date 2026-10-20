import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=(path)=>readFileSync(path,'utf8');

test('Executive has a real database-owned identity separate from ordinary Katie',()=>{
 const migration=read('supabase/migrations/20261020183000_executive_identity_boundary.sql');
 assert.match(migration,/actor_kind text not null default 'standard'/);
 assert.match(migration,/one_executive_actor/);
 assert.match(migration,/where not exists\(select 1 from public.actors where actor_kind='executive'\)/);
 const ui=read('components/specialist-directory.tsx');
 assert.match(ui,/actor\.actorKind === "executive"/);
 assert.doesNotMatch(ui,/actor\.name\.toLowerCase\(\) === "katie"/);
});

test('Executive chat must never fall back to regular language-model work',()=>{
 const chat=read('app/api/chat/route.ts');
 assert.match(chat,/const executiveMode=executiveIdentity\.actor_kind==='executive'/);
 assert.match(chat,/handleExecutiveManagement\(/);
 assert.match(chat,/const projectReply = !executiveMode/);
 assert.match(chat,/const localKatieResponse = executiveMode \?/);
 const manager=read('lib/executive/management.ts');
 assert.match(manager,/executive_management_requests/);
 assert.match(manager,/Ordinary Katie chat will not be used as a fallback/);
 assert.match(manager,/identity\?\.actor_kind!=='executive'/);
});

test('Ordinary actors cannot accidentally remove executive system actor',()=>{
 const api=read('app/api/actors/route.ts');
 assert.match(api,/Executive system identity cannot be deleted/);
 assert.match(api,/Cannot cascade-delete the Executive system identity/);
});
