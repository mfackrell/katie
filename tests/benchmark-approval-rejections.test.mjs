import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
const raw=readFileSync('app/api/benchmark/715/continuation/route.ts','utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
const body={approve:true,authorization:'full-development-resource-amendment-550000tokens-10usd-4hours',projectId:'11111111-1111-4111-8111-111111111111',planHash:'c'.repeat(64)};
function fixture({owner='owner',origin='https://katie.test',release='a'.repeat(40),rpcError=null,throwAt=null}={}){
 const calls=[],logs=[],env={NEXT_PUBLIC_SUPABASE_URL:'https://production.test',NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic',VERCEL_ENV:'production',KATIE_OWNER_AUTH_USER_ID:'owner'};
 const context={console:{warn:(...args)=>logs.push(args)},process:{env},AbortSignal,NextResponse:{json:(body,opts)=>({body,status:opts.status})},config:{productionDatabaseUrl:env.NEXT_PUBLIC_SUPABASE_URL,productionUrl:'https://katie.test'},fetch:async()=>{if(throwAt==='auth')throw Error('secret');return {ok:true,json:async()=>({id:owner})};},qualifiedDevelopmentAmendmentRelease:async()=>{if(throwAt==='release')throw Error('secret');return release;},getSupabaseAdminClient:()=>({rpc:async(name,args)=>{calls.push({name,args});if(throwAt==='rpc')throw Error('secret');return rpcError?{error:{message:rpcError}}:{data:{approved:true,id:'synthetic'}};}})};
 const api=vm.runInNewContext(stripTypeScriptTypes(raw)+';({POST})',context);
 return {calls,logs,post:(payload=body)=>api.POST({headers:{get:k=>k==='authorization'?'Bearer synthetic-owner':k==='origin'?origin:null},json:async()=>payload})};
}
test('exact current owner submission succeeds only through existing RPC',async()=>{
 const h=fixture(),response=await h.post();assert.equal(response.status,200);assert.equal(response.body.continuation.approved,true);assert.equal(h.calls.length,1);assert.equal(h.calls[0].args.p_approve,true);assert.equal(h.calls[0].args.p_plan_hash,body.planHash);assert.equal(h.logs.length,0);
});
test('pre-RPC rejections are distinct and cannot submit owner authority',async()=>{
 for(const [options,payload,status,code] of [
  [{owner:'other'},body,403,'owner_session'],[{origin:'https://other.test'},body,403,'origin'],
  [{},{...body,authorization:'full-development-resource-amendment-fixed-deadline'},400,'outdated_page'],
  [{},{...body,approve:false},400,'amendment_payload'],[{}, {...body,planHash:'bad'},400,'amendment_payload'],
  [{release:null},body,409,'release_unavailable'],[{throwAt:'auth'},body,503,'owner_session_unavailable'],[{throwAt:'release'},body,503,'release_unavailable'],
 ]){const h=fixture(options),response=await h.post(payload);assert.equal(response.status,status);assert.equal(response.body.code,code);assert.equal(h.calls.length,0);assert.equal(h.logs.length,1);assert.ok(!JSON.stringify(h.logs).includes('synthetic-owner'));}
});
test('database reasons are allowlisted; unknown errors and exception details stay private',async()=>{
 for(const [options,code,status] of [[{rpcError:'Review exact current resource amendment plan'},'plan_changed',409],[{rpcError:'Current amendment checkpoint unavailable'},'checkpoint_unavailable',409],[{rpcError:'secret signed payload'},'amendment_database',409],[{throwAt:'rpc'},'amendment_database_unavailable',503]]){
  const h=fixture(options),response=await h.post();assert.equal(response.status,status);assert.equal(response.body.code,code);assert.equal(h.calls.length,1);assert.ok(!JSON.stringify([response,h.logs]).includes('secret'));
 }
});
