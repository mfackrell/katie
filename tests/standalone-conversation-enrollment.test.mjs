import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';
const owner='11111111-1111-4111-8111-111111111111',other='55555555-5555-4555-8555-555555555555',actor='22222222-2222-4222-8222-222222222222',chat='33333333-3333-4333-8333-333333333333';
test('normal conversation POST verifies Auth and enrolls the verified owner, ignoring browser owner claims',async t=>{
 const oldUrl=process.env.NEXT_PUBLIC_SUPABASE_URL,oldKey=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 process.env.NEXT_PUBLIC_SUPABASE_URL='https://auth.example.test';process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='public-key';
 t.after(()=>{if(oldUrl===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY=oldKey;});
 let auth=0;const calls=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{auth++;assert.equal(url,'https://auth.example.test/auth/v1/user');assert.equal(init.headers.Authorization,'Bearer verified-token');return new Response(JSON.stringify({id:owner}));});
 const route=modules({
  '@/lib/agents/store':{managedActor:async()=>false},
  '@/lib/data/persistence-store':{getActorById:async()=>({id:actor,name:'Katie',actorKind:'standard'}),listChatsByActorId:async()=>[],saveChat:async()=>assert.fail('Standalone creation must use atomic ownership RPC')},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return {data:{id:args.p_chat,actor_id:args.p_actor,title:args.p_title,created_at:'2026-10-29T00:00:00Z',updated_at:'2026-10-29T00:00:00Z'},error:null};}})},
 })('@/app/api/chats/route');
 const req=(token)=>new Request('http://localhost/api/chats',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer verified-token'}:{})},body:JSON.stringify({id:chat,actorId:actor,title:'My conversation',ownerId:other})});
 assert.equal((await route.POST(req(false))).status,403);assert.equal(auth,0);assert.equal(calls.length,0);
 const result=await route.POST(req(true));assert.equal(result.status,201);assert.equal((await result.json()).chat.id,chat);
 assert.equal(auth,1);assert.equal(calls.length,1);assert.equal(calls[0].name,'standalone_create_conversation');assert.equal(calls[0].args.p_owner,owner);assert.equal(calls[0].args.p_chat,chat);
});
