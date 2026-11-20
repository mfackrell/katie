import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const sha='a'.repeat(40),otherSha='b'.repeat(40);
const deployment='dpl_ProductionMission79';
const machineSecret='fixture-cron-secret-for-authority-79';
const bypass='fixture-vercel-server-only-bypass';
const alias='https://katie-mu.vercel.app';
const attrs=['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID',
 'CRON_SECRET','VERCEL_AUTOMATION_BYPASS_SECRET','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY'];

function setup(t){
 const snapshot=Object.fromEntries(attrs.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{
  VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:sha,
  VERCEL_DEPLOYMENT_ID:deployment,
  CRON_SECRET:machineSecret,
  VERCEL_AUTOMATION_BYPASS_SECRET:bypass,
  NEXT_PUBLIC_SUPABASE_URL:'https://auth.example.test',
  NEXT_PUBLIC_SUPABASE_ANON_KEY:'anon-fixture-only'
 });
 t.after(()=>{for(const [key,value] of Object.entries(snapshot)){
  if(value===undefined)delete process.env[key];else process.env[key]=value;
 }});
}
function nextAdapter(){
 return {
  next:()=>new Response(null,{status:204}),
  json:(data,opts)=>Response.json(data,opts)
 };
}
function request(path,opts={}){
 const req=new Request(alias+path,opts);
 req.nextUrl=new URL(req.url);
 req.cookies={get:()=>undefined};
 return req;
}

test('middleware permits only exact read-only production machine identity GET; owner Supabase gate stays intact',async t=>{
 setup(t);
 const {middleware}=modules({'next/server':{NextResponse:nextAdapter()}})('@/middleware');
 const valid='/api/version?mission79_verify='+sha;
 const permitted=await middleware(request(valid,{headers:{Authorization:'Bearer '+machineSecret}}));
 assert.equal(permitted.status,204,'Server-to-server identity GET passes existing cron credential');
 const missing=await middleware(request(valid));assert.equal(missing.status,401);
 const wrong=await middleware(request(valid,{headers:{Authorization:'Bearer incorrect-machine'}}));
 assert.equal(wrong.status,401);
 const stale=await middleware(request('/api/version?mission79_verify='+otherSha,
  {headers:{Authorization:'Bearer '+machineSecret}}));
 assert.equal(stale.status,401,'Stale release SHA never receives the machine exception');
 const ordinary=await middleware(request('/api/version',
  {headers:{Authorization:'Bearer '+machineSecret}}));
 assert.equal(ordinary.status,401,'Normal version reads still require a Katie session');
 const post=await middleware(request(valid,{method:'POST',headers:{Authorization:'Bearer '+machineSecret}}));
 assert.equal(post.status,401,'Machine credential grants no version POST');
 const owner=await middleware(request('/api/projects/organization',
  {method:'POST',headers:{Origin:alias,Authorization:'Bearer '+machineSecret}}));
 assert.equal(owner.status,401,'Machine credential cannot enter authenticated owner POST');
 process.env.VERCEL_ENV='preview';
 assert.equal((await middleware(request(valid,{headers:{Authorization:'Bearer '+machineSecret}}))).status,401,
  'Preview deployments cannot use production identity shortcut');
});

test('actual version route and middleware authorize canonical probe; release identity is still exact and fail-closed',async t=>{
 setup(t);
 const next=nextAdapter();
 const {middleware}=modules({'next/server':{NextResponse:next}})('@/middleware');
 const {GET}=modules({
  'next/server':{NextResponse:next},
  '@/lib/standalone-accounting/runpod-policy':{QWEN_STILL_POLICY:{
   provider:'Qwen',model:'fixture',version:'test',reservationMicrousd:0
  }}
 })('@/app/api/version/route');
 const {verifyMission79ActiveProductionSha:verify}
  =modules()('@/lib/projects/mission79-active-release');
 let requests=0,lastHeaders=null,overrideVersion=null,overrideDeployment=null,overrideStatus=null;
 const protectedProductionFetch=async(url,options)=>{
  requests++;lastHeaders=options.headers;
  assert.equal(new URL(url).origin,alias);
  assert.equal(new URL(url).pathname,'/api/version');
  assert.equal(options.redirect,'error');
  assert.equal(options.cache,'no-store');
  if(lastHeaders['x-vercel-protection-bypass']!==bypass)
   return Response.json({error:'deployment_protection'},{status:401});
  if(overrideStatus)return Response.json({error:'edge_failed'},{status:overrideStatus});
  const access=await middleware(request(new URL(url).pathname+new URL(url).search,
   {method:'GET',headers:lastHeaders}));
  if(access.status!==204)return access;
  const real=await GET();
  if(overrideVersion||overrideDeployment){
   const json=await real.json();
   return Response.json({...json,
    version:overrideVersion??json.version,
    deploymentId:overrideDeployment??json.deploymentId
   },{status:200});
  }
  return real;
 };
 assert.equal(await verify(sha,protectedProductionFetch),true,
  'Actual app middleware + version handler must permit authenticated machine proof');
 assert.equal(lastHeaders.Authorization,'Bearer '+machineSecret);
 assert.equal(lastHeaders['x-vercel-protection-bypass'],bypass);
 assert.ok(!('Cookie' in lastHeaders),'Server-only bypass requires no owner cookie');
 const accepted=requests;
 assert.equal(await verify(otherSha,protectedProductionFetch),false);
 assert.equal(requests,accepted,'Wrong initiating SHA fails before network');
 overrideVersion=otherSha;assert.equal(await verify(sha,protectedProductionFetch),false);
 overrideVersion=null;
 overrideDeployment='dpl_WrongProduction';assert.equal(await verify(sha,protectedProductionFetch),false);
 overrideDeployment=null;
 overrideStatus=403;assert.equal(await verify(sha,protectedProductionFetch),false);
 overrideStatus=null;
 process.env.VERCEL_AUTOMATION_BYPASS_SECRET='invalid-bypass';
 assert.equal(await verify(sha,protectedProductionFetch),false,
  'Vercel Authentication remains enforced with wrong bypass');
 process.env.VERCEL_AUTOMATION_BYPASS_SECRET=bypass;
 delete process.env.CRON_SECRET;
 const prior=requests;assert.equal(await verify(sha,protectedProductionFetch),false);
 assert.equal(requests,prior,'Absent machine secret fails before network');
});
