import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundledChromium from '@sparticuz/chromium';
import {modules} from './load-project-modules.mjs';

// Actual Chromium UI -> first-party Next route -> verified Supabase-style
// owner bearer -> real PostgreSQL owner writer -> durable owner receipt.
// Entire write is nested in a native disposable transaction SAVEPOINT.
export async function assertMission79BrowserPostgres(first,{
 project,owner,release,missionId,assignmentId,stage
}){
 assert.ok(['authorize','authorized'].includes(stage));
 const initialRpc=stage==='authorize'
  ?'project_org_retest_future_window_offer':'project_org_retest_future_window_offer';
 const original={
  VERCEL_ENV:process.env.VERCEL_ENV,
  VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA,
  KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID,
  NEXT_PUBLIC_SUPABASE_URL:process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY:process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
 };
 const initial=(await first.query('select project_org_retest_future_window_offer($1,$2,$3) r',
  [owner,project,release])).rows[0].r;
 assert.equal(initial.stage,stage);
 assert.equal(initial.missionId,missionId);
 assert.equal(initial.assignmentId,assignmentId);
 const chosen=new Date(Date.now()+3*3600000);
 chosen.setSeconds(0,0);
 const chosenIso=chosen.toISOString();
 const selectedLocal=chosenIso.slice(0,16);
 const beforeAuth=(await first.query('select count(*)::int n from project_retest_future_window_receipts where project_id=$1',
  [project])).rows[0].n;
 const beforeBind=(await first.query('select count(*)::int n from project_retest_claim_release_receipts where project_id=$1',
  [project])).rows[0].n;
 const rpcCalls=[];
 const adapter=async(name,args)=>{
  rpcCalls.push(name);
  const queries={
   project_org_retest_future_window_offer:[
    'select project_org_retest_future_window_offer($1,$2,$3) r',
    [args.p_owner,args.p_project,args.p_release]],
   project_org_authorize_retest_future_window:[
    'select project_org_authorize_retest_future_window($1,$2,$3,$4,$5,$6,$7,$8) r',
    [args.p_owner,args.p_project,args.p_release,args.p_mission,args.p_assignment,
     args.p_authorization,args.p_cutoff,args.p_state_hash]],
   project_org_retest_claim_release_offer:[
    'select project_org_retest_claim_release_offer($1,$2,$3) r',
    [args.p_owner,args.p_project,args.p_release]],
   project_org_bind_retest_claim_release:[
    'select project_org_bind_retest_claim_release($1,$2,$3,$4,$5,$6) r',
    [args.p_owner,args.p_project,args.p_release,args.p_mission,args.p_assignment,args.p_state_hash]],
  };
  const entry=queries[name];
  if(!entry)throw Error('Browser integration attempted unexpected database call '+name);
  return (await first.query(entry[0],entry[1])).rows[0].r;
 };
 // Record whether the real owner verifier attempts its local auth fetch,
 // without logging bearer values or changing its security decision.
 const authFetchAttempts=[];
 const underlyingFetch=globalThis.fetch;
 globalThis.fetch=async(...args)=>{
  const target=typeof args[0]==='string'?args[0]:args[0]?.url;
  const ownerLookup=typeof target==='string'&&target.endsWith('/auth/v1/user');
  try{
   const response=await underlyingFetch(...args);
   if(ownerLookup)authFetchAttempts.push({status:response.status});
   return response;
  }catch(error){
   if(ownerLookup)authFetchAttempts.push({error:error instanceof Error?error.message:String(error)});
   throw error;
  }
 };
 let POST;
 try{
  ({POST}=modules({
   '@/lib/missions/store':{rpc:adapter},
   '@/lib/projects/mission79-active-release':{
    verifyMission79ActiveProductionSha:async sha=>sha===release
   },
   '@/lib/data/persistence-store':{getMessages:async()=>[]},
  })('@/app/api/projects/organization/route'));
 }finally{globalThis.fetch=underlyingFetch;}
 const source=ts.transpileModule(
  readFileSync('components/mission79-future-window-control.tsx','utf8'),{
   compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
 const react=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js']
  .map(p=>readFileSync('node_modules/'+p,'utf8')).join('\n');
 const browserScript='const exports={};const require=n=>n==="react"?React:'+
  'n==="react/jsx-runtime"?{Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:'+
  '{ownerSessionBearer:async()=> "integrated-owner-token"};'+
  'window.refreshes=0;'+source+
  ';ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(exports.Mission79FutureWindowControl,{initial:'+
  JSON.stringify(initial)+',onRefresh:()=>window.refreshes++}));';
 let baseUrl='',posts=0,authRequests=0;
 const postResults=[];
 const browserErrors=[];
 const waitForSuccess=async message=>{
  try{await page.getByText(message).waitFor({timeout:15000});}
  catch(error){
   const alerts=await page.locator('[role="alert"]').allTextContents().catch(()=>[]);
   const bodyText=await page.locator('body').innerText().catch(()=>'');
   throw new Error('MISSION79_BROWSER_POSTGRES_DIAGNOSTIC '+JSON.stringify({
    stage,posts,authRequests,authFetchAttempts,rpcCalls,postResults,alerts,
    browserErrors,bodyText:bodyText.slice(0,1200),
   })+'; '+(error instanceof Error?error.message:String(error)));
  }
 };
 const server=createServer(async(req,res)=>{
  const fail=(status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(body));};
  try{
   const u=new URL(req.url,baseUrl||'http://127.0.0.1');
   if(req.method==='GET'&&u.pathname==='/owner'){
    res.statusCode=200;res.setHeader('content-type','text/html; charset=utf-8');
    res.end('<!doctype html><html><div id="root"></div><script>'+react+'</script><script>'+browserScript+'</script></html>');
    return;
   }
   if(req.method==='GET'&&u.pathname==='/auth/v1/user'){
    authRequests++;
    if(req.headers.authorization!=='Bearer integrated-owner-token'
     ||req.headers.apikey!=='native-owner-qa-key')return fail(403,{error:'unauthorized'});
    return fail(200,{id:owner});
   }
   if(req.method==='POST'&&u.pathname==='/api/projects/organization'){
    posts++;
    const chunks=[];for await(const c of req)chunks.push(c);
    const request=new Request(baseUrl+u.pathname,{
     method:'POST',headers:new Headers(req.headers),
     body:Buffer.concat(chunks),
    });
    const result=await POST(request);
    const responseText=await result.text();
    postResults.push({status:result.status,response:responseText.slice(0,800),
     sentOrigin:req.headers.origin??null,requestOrigin:new URL(request.url).origin,
     bearerPresent:typeof req.headers.authorization==='string',
     bearerSyntax:/^Bearer [A-Za-z0-9._~-]+$/.test(req.headers.authorization??''),
     configured:{production:process.env.VERCEL_ENV==='production',
      authEndpoint:!!process.env.NEXT_PUBLIC_SUPABASE_URL,
      publicKey:!!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      ownerId:!!process.env.KATIE_OWNER_AUTH_USER_ID}
    });
    res.statusCode=result.status;res.setHeader('content-type','application/json');
    res.end(responseText);
    return;
   }
   fail(404,{error:'unknown test route'});
  }catch(e){fail(500,{error:e instanceof Error?e.message:String(e)});}
 });
 let browser,context,page;
 await first.query('savepoint integrated_owner_ui');
 try{
  await new Promise((resolve,reject)=>{
   server.once('error',reject);
   server.listen(0,'127.0.0.1',resolve);
  });
  baseUrl='http://127.0.0.1:'+server.address().port;
  Object.assign(process.env,{
   VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:release,
   KATIE_OWNER_AUTH_USER_ID:owner,
   NEXT_PUBLIC_SUPABASE_URL:baseUrl,
   NEXT_PUBLIC_SUPABASE_ANON_KEY:'native-owner-qa-key',
  });
  // @sparticuz/chromium's serverless flags include --disable-web-security;
  // that alters browser Origin semantics and invalidates this CSRF acceptance
  // test. Keep required serverless flags but restore real first-party security.
  const originSafeArgs=bundledChromium.args.filter(arg=>
   arg!=='--disable-web-security'&&arg!=='--allow-running-insecure-content');
  assert.ok(!originSafeArgs.includes('--disable-web-security'));
  browser=await chromium.launch({
   executablePath:process.env.KATIE_TEST_CHROMIUM||await bundledChromium.executablePath(),
   args:originSafeArgs,headless:true,
  });
  context=await browser.newContext({timezoneId:'UTC'});
  page=await context.newPage();
  page.on('pageerror',e=>browserErrors.push(e.message));
  await page.goto(baseUrl+'/owner',{waitUntil:'domcontentloaded',timeout:12000});
  if(stage==='authorize'){
   const cutoff=page.locator('#mission79-cutoff');
   await cutoff.waitFor({timeout:12000});
   assert.equal(await cutoff.inputValue(),'','UI must never preselect new authority');
   await cutoff.fill(selectedLocal);
   await page.getByRole('button',{name:'Approve new execution window'}).click();
   await waitForSuccess('Owner window recorded.');
   const recorded=(await first.query('select owner_id,cutoff from project_retest_future_window_receipts where project_id=$1',
    [project])).rows[0];
   assert.equal(recorded.owner_id,owner);
   assert.equal(new Date(recorded.cutoff).toISOString(),chosenIso);
   assert.equal((await first.query('select count(*)::int n from project_retest_future_window_receipts where project_id=$1',
    [project])).rows[0].n,beforeAuth+1);
   assert.equal((await first.query('select count(*)::int n from project_retest_claim_release_receipts where project_id=$1',
    [project])).rows[0].n,beforeBind,'Browser owner cutoff must not bind release');
  }else{
   await page.getByRole('button',{name:'Resume one owner-approved management decision'}).click();
   await waitForSuccess('Exact release binding is recorded.');
   const recorded=(await first.query('select owner_id,bound_release_sha,assignment_id from project_retest_claim_release_receipts where project_id=$1',
    [project])).rows[0];
   assert.equal(recorded.owner_id,owner);
   assert.equal(recorded.bound_release_sha,release);
   assert.equal(recorded.assignment_id,assignmentId);
   assert.equal((await first.query('select count(*)::int n from project_retest_claim_release_receipts where project_id=$1',
    [project])).rows[0].n,beforeBind+1);
  }
  assert.equal(posts,1,'Browser owner action must produce exactly one POST');
  assert.ok(authRequests>=1,'Real first-party owner verifier must fetch authenticated Supabase-style identity');
  assert.equal(await page.evaluate(()=>window.refreshes),1);
  assert.deepEqual(browserErrors,[]);
  assert.ok(rpcCalls.includes(stage==='authorize'
   ?'project_org_authorize_retest_future_window':'project_org_bind_retest_claim_release'));
  console.log('MISSION79_BROWSER_TO_AUTHENTICATED_ROUTE_TO_REAL_POSTGRES_'+stage.toUpperCase()+'_PASS: first-party cutoff/bearer, owner verification, immutable SQL receipt, rollback');
 }finally{
  try{if(page)await page.close({runBeforeUnload:false});}catch{}
  try{if(context)await context.close();}catch{}
  try{if(browser)await browser.close();}catch{}
  await new Promise(resolve=>server.close(()=>resolve()));
  for(const [k,v] of Object.entries(original)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  await first.query('rollback to savepoint integrated_owner_ui');
  await first.query('release savepoint integrated_owner_ui');
 }
}
