import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundled from '@sparticuz/chromium';
import {modules} from './load-project-modules.mjs';

// First-party mobile browser -> real owner authentication/route -> disposable
// PostgreSQL RPC. Does not connect to production or a paid provider.
export async function assertBlockedOwnerBrowser(db,{project,owner,release}){
 const saved={...process.env};const scratch=mkdtempSync(join(tmpdir(),'blocked-owner-browser-'));
 const original='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
 let server,browser;let posts=0;const calls=[];
 await db.query('savepoint blocked_owner_browser');
 try{
  Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:release,KATIE_OWNER_AUTH_USER_ID:owner,
   NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-key'});
  const signatures={
   project_org_management_activation_offer:['p_owner','p_project','p_release'],
   project_org_blocked_owner_offer:['p_owner','p_project','p_release'],
   project_org_authorize_blocked_owner_window:['p_owner','p_project','p_release','p_prior_window','p_prior_cutoff','p_cutoff','p_authorization','p_state_hash'],
   project_org_resume_blocked_owner_confirmed:['p_owner','p_project','p_release','p_authorization','p_cutoff','p_state_hash'],
  };
  const rpc=async(name,args)=>{
   assert.ok(signatures[name],name);calls.push(name);
   await db.query('savepoint browser_rpc');
   try{
    const a=signatures[name].map(k=>args[k]);
    const result=(await db.query('select '+name+'('+a.map((_,i)=>'$'+(i+1)).join(',')+') result',a)).rows[0].result;
    await db.query('release savepoint browser_rpc');return result;
   }catch(e){await db.query('rollback to savepoint browser_rpc');await db.query('release savepoint browser_rpc');throw e;}
  };
  const load=modules({'@/lib/missions/store':{rpc},'@/lib/data/persistence-store':{getMessages:async()=>[]}});
  const route=load('@/app/api/projects/organization/route');
  const react=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js']
   .map(f=>readFileSync('node_modules/'+f,'utf8')).join('\n');
  const source=readFileSync('components/director-recovery-control.tsx','utf8');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  server=createServer(async(req,res)=>{
   try{
    const url=new URL(req.url,'http://'+req.headers.host);
    if(url.pathname==='/auth/v1/user'){
     const bearer=req.headers.authorization??'';
     res.writeHead(bearer==='Bearer synthetic-owner'?200:401,{'Content-Type':'application/json'});
     res.end(JSON.stringify({id:bearer==='Bearer synthetic-owner'?owner:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}));return;
    }
    if(url.pathname==='/control'){
     const token=url.searchParams.get('session')==='wrong'?'other-owner':
      url.searchParams.get('session')==='missing'?null:'synthetic-owner';
     const harness='const exports={};const require=n=>n==="react"?React:n==="react/jsx-runtime"?{Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:{ownerSessionBearer:async()=>'+JSON.stringify(token)+'};'+js+
      ';window.refreshes=0;(async()=>{const bearer=await require("session").ownerSessionBearer();const r=await fetch("/api/projects/organization?projectId='+original+'",{headers:bearer?{Authorization:"Bearer "+bearer}:{}});const data=await r.json();ReactDOM.createRoot(document.getElementById("root")).render(r.ok?React.createElement(exports.DirectorRecoveryControl,{recovery:{projectId:"'+original+'",releaseSha:"'+release+'",cutoff:"2026-11-16T18:00:00Z",priorCutoff:"2026-11-16T18:00:00Z",receipt:null,blockedOwnerRecovery:data.blockedOwnerRecovery},onRefresh:()=>window.refreshes++}):React.createElement("p",{role:"alert"},data.error));})();';
     res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><p>Disposable native qualification</p><div id="root"></div><script>'+react+'</script><script>'+harness+'</script></body></html>');return;
    }
    assert.equal(url.pathname,'/api/projects/organization');
    const chunks=[];for await(const ch of req)chunks.push(ch);
    const body=Buffer.concat(chunks).toString();
    if(req.method==='POST')posts++;
    const request=new Request(url,{method:req.method,headers:req.headers,...(body?{body}:{})});
    const response=await route[req.method](request);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
   }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(e)}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;process.env.NEXT_PUBLIC_SUPABASE_URL=origin;
  const get=async(token='synthetic-owner')=>fetch(origin+'/api/projects/organization?projectId='+original,{headers:token?{Authorization:'Bearer '+token}:{}});
  const initialResponse=await get();
  assert.equal(initialResponse.status,200,await initialResponse.clone().text());
  const initial=(await initialResponse.json()).blockedOwnerRecovery;
  assert.equal(initial.stage,'authorize');assert.equal(initial.historicalMissions,76);
  assert.equal((await get('wrong-owner')).status,403);assert.equal((await get(null)).status,403);
  const post=async(body,headers={})=>fetch(origin+'/api/projects/organization',{
   method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-owner',Origin:origin,...headers},
   body:JSON.stringify(body),
  });
  const chosen=new Date(Date.now()+3600000).toISOString();
  const auth={trialAction:'authorize_blocked_window',projectId:original,releaseSha:release,
   priorWindowId:initial.priorWindowId,priorCutoff:initial.priorCutoff,
   cutoff:chosen,authorizationId:crypto.randomUUID(),stateHash:initial.stateHash};
  assert.equal((await post({...auth,stateHash:'f'.repeat(64)})).status,409);
  assert.equal((await post(auth,{Origin:'https://wrong-origin.test'})).status,403);
  assert.equal((await post(auth,{Authorization:'Bearer other-owner'})).status,403);
  for(const env of ['preview','development']){
   process.env.VERCEL_ENV=env;assert.ok([403,409].includes((await post(auth)).status));
  }process.env.VERCEL_ENV='production';
  browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundled.executablePath(),
   args:bundled.args.filter(arg=>arg!=='--disable-web-security'),headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'America/Chicago'});
  for(const session of ['missing','wrong']){
   const page=await context.newPage();await page.goto(origin+'/control?session='+session);
   await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('button').count(),0);await page.close();
  }
  const page=await context.newPage();const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(origin+'/control');
  await page.getByText('Project blocked. No new cutoff or resume is authorized.').waitFor();
  assert.equal(await page.getByRole('button',{name:'Resume original management separately'}).count(),0);
  const initialPosts=posts;await page.reload();await page.getByText('Project blocked. No new cutoff or resume is authorized.').waitFor();
  assert.equal(posts,initialPosts,'Loading/reloading never authorizes or resumes');
  const authorizeButton=page.getByRole('button',{name:'Authorize new cutoff only'});
  assert.equal(await authorizeButton.isDisabled(),true,'No cutoff may be auto-selected');
  const cutoffValue=await page.evaluate(()=>{
   const d=new Date(Date.now()+3600000);
   const pad=n=>String(n).padStart(2,'0');
   return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
  });
  await page.getByLabel('Explicit new cutoff (local time)').fill(cutoffValue);
  assert.equal(await authorizeButton.isEnabled(),true);
  const preClick=posts;await authorizeButton.evaluate(el=>{el.click();el.click();});
  await page.getByText('Project still blocked.',{exact:false}).waitFor({timeout:12000});
  assert.equal(posts,preClick+1,'Double click authorizes only one window');
  assert.equal((await db.query('select status from work_projects where id=$1',[original])).rows[0].status,'blocked');
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[original])).rows[0].n,76);
  const renewed=(await (await get()).json()).blockedOwnerRecovery;
  assert.equal(renewed.stage,'resume');assert.ok(renewed.authorizationId);
  const afterLoad=posts;await page.reload();await page.getByRole('button',{name:'Resume original management separately'}).waitFor();
  assert.equal(posts,afterLoad,'Reload must not resume');
  const resume={trialAction:'resume_blocked_management',projectId:original,releaseSha:release,
   authorizationId:renewed.authorizationId,cutoff:renewed.cutoff,stateHash:renewed.stateHash};
  assert.equal((await post({...resume,stateHash:initial.stateHash})).status,409);
  await page.getByRole('button',{name:'Resume original management separately'}).evaluate(el=>{el.click();el.click();});
  await page.getByText('Management resumed under the recorded owner window.').waitFor({timeout:12000});
  assert.equal((await db.query('select status from work_projects where id=$1',[original])).rows[0].status,'running');
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[original])).rows[0].n,76);
  assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[original])).rows[0].n,0);
  assert.deepEqual(pageErrors,[]);
  assert.ok(calls.includes('project_org_authorize_blocked_owner_window'));
  assert.ok(calls.includes('project_org_resume_blocked_owner_confirmed'));
  await page.close();
  console.log('BLOCKED_OWNER_BROWSER_API_POSTGRES_PASS: real 390px first-party browser, owner auth, explicit cutoff, separate resume, double-click/reload/replay/wrong-owner/origin/preview negatives, 76 immutable missions, zero inference/dispatch');
 }finally{
  if(browser)await browser.close().catch(()=>{});
  if(server)await new Promise(resolve=>server.close(resolve));
  for(const k of ['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','KATIE_OWNER_AUTH_USER_ID','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY']){
   if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];
  }
  await db.query('rollback to savepoint blocked_owner_browser');
  await db.query('release savepoint blocked_owner_browser');
 }
}
