import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';
import {readFileSync} from 'node:fs';

const owner='11111111-1111-4111-8111-111111111111';
const guest='99999999-9999-4999-8999-999999999999';
const actor='22222222-2222-4222-8222-222222222222';
const chat='33333333-3333-4333-8333-333333333333';

function environment(t){
  const previous={url:process.env.NEXT_PUBLIC_SUPABASE_URL,key:process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,owner:process.env.KATIE_OWNER_AUTH_USER_ID};
  process.env.NEXT_PUBLIC_SUPABASE_URL='https://auth.example.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='public-key';
  process.env.KATIE_OWNER_AUTH_USER_ID=owner;
  t.after(()=>{
    for(const [key,value] of Object.entries({
      NEXT_PUBLIC_SUPABASE_URL:previous.url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY:previous.key,
      KATIE_OWNER_AUTH_USER_ID:previous.owner
    })) value===undefined?delete process.env[key]:process.env[key]=value;
  });
}
const sessionRequest=(headers={})=>({
  nextUrl:new URL('https://katie.example.test/api/session'),
  headers:new Headers({'origin':'https://katie.example.test',...headers})
});
test('opening Katie anonymously mints a server-managed cookie and isolated guest workspace',async t=>{
  environment(t);
  let newSessions=0;const rpc=[];
  const route=modules({
    '@supabase/supabase-js':{createClient:()=>({auth:{
      signInAnonymously:async()=>{newSessions++;return {error:null,data:{
        user:{id:guest,is_anonymous:true},
        session:{access_token:'guest-access-token',refresh_token:'guest-refresh-token',expires_in:1800}
      }};}}
    })},
    '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>({
      rpc:async(name,args)=>{rpc.push({name,args});return {data:actor,error:null};}
    })}
  })('@/app/api/session/route');
  const response=await route.POST(sessionRequest());
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ready:true,guest:true});
  assert.equal(response.cookies.get('katie_session_access').value,'guest-access-token');
  assert.equal(response.cookies.get('katie_session_refresh').value,'guest-refresh-token');
  assert.equal(response.cookies.get('katie_session_access').httpOnly,true);
  assert.equal(response.cookies.get('katie_session_access').sameSite,'strict');
  assert.equal(newSessions,1);
  assert.equal(rpc.length,1);
  assert.equal(rpc[0].name,'standalone_guest_workspace');
  assert.equal(rpc[0].args.p_owner,guest);
});
test('existing signed-in owner is reused without guest signup',async t=>{
  environment(t);
  let signups=0;
  t.mock.method(globalThis,'fetch',async()=>Response.json({id:owner,is_anonymous:false}));
  const route=modules({
    '@supabase/supabase-js':{createClient:()=>{signups++;throw Error('must not be called');}},
    '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>{throw Error('must not be called');}}
  })('@/app/api/session/route');
  const response=await route.POST(sessionRequest({authorization:'Bearer original-owner-token'}));
  assert.equal(response.status,200);
  assert.equal((await response.json()).guest,false);
  assert.equal(response.cookies.get('katie_session_access').value,'original-owner-token');
  assert.equal(signups,0);
});
test('cross-origin session issuance is rejected',async t=>{
  environment(t);
  const route=modules({
    '@supabase/supabase-js':{createClient:()=>{throw Error('cross-origin must not create a session');}},
  })('@/app/api/session/route');
  const response=await route.POST(sessionRequest({origin:'https://attacker.example'}));
  assert.equal(response.status,403);
});
test('server verifies guest cookie before authorizing a conversation',async t=>{
  environment(t);
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'https://auth.example.test/auth/v1/user');
    assert.equal(init.headers.Authorization,'Bearer valid-guest-cookie');
    return Response.json({id:guest,is_anonymous:true});
  });
  const auth=modules({
    '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>({
      rpc:async(name,args)=>{calls.push({name,args});return {data:true,error:null};}
    })}
  })('@/lib/standalone-accounting/auth');
  const request={headers:new Headers({cookie:'other=x; katie_session_access=valid-guest-cookie'})};
  assert.equal(await auth.authorizeStandaloneCaller(request,actor,chat),guest);
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,'standalone_authorize_scope');
  assert.equal(calls[0].args.p_owner,guest);
});
test('guest chat creation uses isolated atomic enrollment, never generic saveChat',async t=>{
  environment(t);
  t.mock.method(globalThis,'fetch',async()=>Response.json({id:guest,is_anonymous:true}));
  const calls=[];
  const route=modules({
    '@/lib/agents/store':{managedActor:async()=>false},
    '@/lib/data/persistence-store':{
      getActorById:async()=>({id:actor,name:'Katie',actorKind:'standard'}),
      listChatsByActorId:async()=>[],
      saveChat:async()=>assert.fail('Guest must use atomic owner-bound enrollment')
    },
    '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>({
      rpc:async(name,args)=>{calls.push({name,args});return {data:{
        id:chat,actor_id:actor,title:'Hi',created_at:'2026-10-30T00:00:00Z',updated_at:'2026-10-30T00:00:00Z'
      },error:null};}
    })}
  })('@/app/api/chats/route');
  const response=await route.POST(new Request('http://localhost/api/chats',{
    method:'POST',headers:{cookie:'katie_session_access=guest-token','content-type':'application/json'},
    body:JSON.stringify({id:chat,actorId:actor,title:'Hi'})
  }));
  assert.equal(response.status,201);
  assert.equal(calls[0].name,'standalone_guest_create_conversation');
  assert.equal(calls[0].args.p_owner,guest);
});


test('guest cannot invoke executive, project or repository inspection execution',()=>{
  const source=readFileSync('app/api/chat/route.ts','utf8');
  assert.match(source,/if\(actorRole\.actor_kind==='executive'\)\{/);
  assert.match(source,/if\(principal\.isAnonymous \|\| principal\.id!==process\.env\.KATIE_OWNER_AUTH_USER_ID\)/);
  assert.match(source,/const selfInspectionRequest = !isGuestSession && isExplicitKatieSelfInspectionRequest\(message\)/);
  assert.match(source,/const savedBenchmarkProject = !isGuestSession && !currentAgentTask\(\)/);
  assert.match(source,/const projectReply = !isGuestSession && !pdfProgress\.projectClarification/);
});

test('explicit owner sign-out replaces the owner cookie instead of silently reusing it',async t=>{
  environment(t);
  t.mock.method(globalThis,'fetch',async()=>assert.fail('Old owner cookie must not be reused after sign-out'));
  const route=modules({
    '@supabase/supabase-js':{createClient:()=>({auth:{
      signInAnonymously:async()=>({error:null,data:{
        user:{id:guest,is_anonymous:true},
        session:{access_token:'new-guest-access',refresh_token:'new-guest-refresh',expires_in:1800}
      }})
    }})},
    '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>({
      rpc:async()=>({data:actor,error:null})
    })}
  })('@/app/api/session/route');
  const response=await route.POST(sessionRequest({
    cookie:'katie_session_access=still-valid-owner-token',
    'x-katie-guest-reset':'1'
  }));
  assert.equal(response.status,200);
  assert.equal((await response.json()).guest,true);
  assert.equal(response.cookies.get('katie_session_access').value,'new-guest-access');
  assert.equal(response.cookies.get('katie_session_refresh').value,'new-guest-refresh');
});
