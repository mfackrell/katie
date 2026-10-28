import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import config from '../config/benchmark-715-production-qualification.json' with {type:'json'};
const code=ts.transpileModule(readFileSync('app/api/benchmark/715/continuation/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(owner='owner',dbError=false){
 const calls=[],out={};
 vm.runInNewContext(code,{exports:out,AbortSignal,process:{env:{VERCEL_ENV:'production',NEXT_PUBLIC_SUPABASE_URL:config.productionDatabaseUrl,NEXT_PUBLIC_SUPABASE_ANON_KEY:'public',KATIE_OWNER_AUTH_USER_ID:'owner'}},fetch:async()=>({ok:true,json:async()=>({id:owner})}),require:name=>name==='next/server'?{NextResponse:{json:(body,options)=>({body,status:options.status})}}:name.includes('config/')?{default:config}:{getSupabaseAdminClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return {data:{approved:true},error:dbError?{}:null}}})}});
 const body={approve:true,authorization:'full-continuation-existing-budget-270000tokens-4hours',projectId:'a'.repeat(8)+'-1111-4111-8111-'+'b'.repeat(12),planHash:'c'.repeat(64)};
 return {calls,body,post:(b=body,headers={authorization:'Bearer session',origin:config.productionUrl})=>out.POST({json:async()=>b,headers:new Headers(headers)}),get:()=>out.GET({headers:new Headers({authorization:'Bearer session'})})};
}
test('continuation approval requires authenticated owner, exact origin and explicit task scope consent',async()=>{
 const other=harness('other');assert.equal((await other.post()).status,403);assert.equal(other.calls.length,0);
 const h=harness();assert.equal((await h.post(undefined,{})).status,403);
 assert.equal((await h.post(undefined,{authorization:'Bearer session',origin:'https://wrong.example'})).status,403);
 assert.equal((await h.post({...h.body,approve:false})).status,400);
 assert.equal((await h.post({...h.body,planHash:null})).status,400);assert.equal(h.calls.length,0);
 assert.equal((await h.post({...h.body,owner:'attacker',maxTokens:999999,deadline:'2099-01-01'})).status,200);
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])),{name:'benchmark_dashboard_continuation',args:{p_owner:'owner',p_project:h.body.projectId,p_plan_hash:h.body.planHash,p_approve:true}});
});
test('continuation status is owner-only and stale or expired DB authority cannot be replaced',async()=>{
 const other=harness('other');assert.equal((await other.get()).status,401);assert.equal(other.calls.length,0);
 const h=harness('owner',true);assert.equal((await h.post()).status,409);assert.equal(h.calls.length,1);
});

