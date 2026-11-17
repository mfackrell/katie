import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundled from '@sparticuz/chromium';
import {createHash} from 'node:crypto';
import {modules} from './load-project-modules.mjs';

// This production-shaped fixture exists only in a disposable native database.
// Normalize identities BEFORE restoring triggers; runtime routes and SQL guards
// are then executed unmodified, including their original-project restrictions.
export async function assertOwnerManagementBrowser(db,x){
 const original={project:'fe9d2658-41e3-44c1-ae8e-a0cba98371fe',source:'62cd8da3-1bcc-41ae-9470-574c6b05e420',window:'a837004e-75d3-497d-b05a-482886ed5a5f',scope:'4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6',release:'c1d9a5f1ac10396c3015a7d5ae5f22254502e5de'};
 const cutoff='2026-11-16T18:00:00Z',prior='2026-11-15T18:00:00Z',activeRelease=x.newRelease;
 const evidenceDir='test-artifacts/owner-management-activation';mkdirSync(evidenceDir,{recursive:true});
 const saved={...process.env};let browser,server;const scratch=mkdtempSync(join(tmpdir(),'owner-management-browser-'));
 await db.query('savepoint owner_browser_fixture');
 try{
  await db.query('reset role');await db.query("set local session_replication_role='replica'");
  const replacements=[[x.project,original.project],[x.source.mission,original.source],[x.originalWindow,original.window],[x.scopeHash,original.scope],[x.intermediate,original.release]];
  for(const [old,value] of replacements){
   const tables=(await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
   for(const {tablename} of tables){
    const q='"'+tablename.replaceAll('"','""')+'"';
    const columns=(await db.query("select attname from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped and attgenerated='' and attidentity='' order by attnum",['public.'+q])).rows.map(r=>'"'+r.attname.replaceAll('"','""')+'"').join(',');
    if(!columns)continue;
    await db.query('update public.'+q+' t set ('+columns+')=(select '+columns+' from jsonb_populate_record(null::public.'+q+',replace(to_jsonb(t)::text,$1,$2)::jsonb)) where position($1 in to_jsonb(t)::text)>0',[old,value]);
   }
  }
  await db.query('update project_execution_windows set prior_cutoff=$2::timestamptz-interval \'24 hours\',cutoff=$2 where id=$1',[original.window,prior]);
  await db.query('update project_scoped_root_retry_receipts set cutoff=$2 where project_id=$1',[original.project,prior]);
  await db.query('update work_projects set deadline=$2 where id=$1',[original.project,prior]);
  await db.query('update project_provider_execution set deadline=$2 where project_id=$1',[original.project,prior]);
  await db.query('update project_organization_nodes set deadline=$2 where project_id=$1',[original.project,prior]);
  await db.query('update agent_missions set deadline=$2 where id=$1',[original.source,prior]);
  await db.query("set local session_replication_role='origin'");await db.query('set role service_role');
  Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:activeRelease,KATIE_OWNER_AUTH_USER_ID:x.owner,NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-key'});
  const calls=[];
  const rpc=async(name,args)=>{
   calls.push({name,args});
   const signatures={
    project_org_management_activation_offer:['p_owner','p_project','p_release'],
    project_org_renew_paused_window:['p_owner','p_project','p_release','p_expected_release','p_scope_hash','p_source_mission','p_prior_window','p_prior_cutoff','p_cutoff','p_authorization','p_state_hash'],
    project_org_resume_management_confirmed:['p_owner','p_project','p_release','p_authorization','p_state_hash'],
   };
   assert.ok(signatures[name],'Only the actual recovery RPCs may execute');
   await db.query('savepoint http_rpc');
   try{
    const result=(await db.query('select '+name+'('+signatures[name].map((_,i)=>'$'+(i+1)).join(',')+') result',signatures[name].map(k=>args[k]))).rows[0].result;
    await db.query('release savepoint http_rpc');return result;
   }catch(error){console.log('OWNER_BROWSER_SQL_REJECTION',name,error.message);await db.query('rollback to savepoint http_rpc');await db.query('release savepoint http_rpc');throw error;}
  };
  const load=modules({'@/lib/missions/store':{rpc},'@/lib/data/persistence-store':{getMessages:async()=>[]}});
  const route=load('@/app/api/projects/organization/route');
  const react=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js'].map(f=>readFileSync('node_modules/'+f,'utf8')).join('\n');
  const js=ts.transpileModule(readFileSync('components/director-recovery-control.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const cssResult=spawnSync(process.execPath,['node_modules/tailwindcss/lib/cli.js','-i','app/globals.css','-o',join(scratch,'app.css'),'--minify'],{encoding:'utf8',timeout:30000});
  assert.equal(cssResult.status,0,cssResult.stderr);const css=readFileSync(join(scratch,'app.css'),'utf8');
  let posts=0,droppedResponse=false,dropNextRenewal=false;
  server=createServer(async(req,res)=>{
   try{
    const url=new URL(req.url,'http://'+req.headers.host);
    if(url.pathname==='/auth/v1/user'){
     const token=req.headers.authorization;
     res.writeHead(token?'200':'401',{'Content-Type':'application/json'});
     res.end(JSON.stringify({id:token==='Bearer synthetic-owner'?x.owner:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}));return;
    }
    if(url.pathname==='/control'){
     const token=url.searchParams.get('session')==='missing'?null:url.searchParams.get('session')==='wrong'?'other-owner':'synthetic-owner';
     const code='const exports={};const require=n=>n==="react"?React:n==="react/jsx-runtime"?{Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:{ownerSessionBearer:async()=>'+JSON.stringify(token)+'};'+js+
      ';window.refreshes=0;(async()=>{const bearer=await require("session").ownerSessionBearer();const r=await fetch("/api/projects/organization?projectId='+original.project+'",{headers:bearer?{Authorization:"Bearer "+bearer}:{}});const data=await r.json();ReactDOM.createRoot(document.getElementById("root")).render(r.ok?React.createElement(exports.DirectorRecoveryControl,{recovery:{projectId:"'+original.project+'",releaseSha:"'+activeRelease+'",cutoff:"'+cutoff+'",priorCutoff:"'+prior+'",receipt:null,managementActivation:data.managementActivation},onRefresh:()=>window.refreshes++}):React.createElement("p",{role:"alert"},data.error));})();';
     res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body><p>Isolated engineering test — synthetic records</p><div id="root"></div><script>'+react+'</script><script>'+code+'</script></body></html>');return;
    }
    assert.equal(url.pathname,'/api/projects/organization');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks).toString();if(req.method==='POST')posts++;
    const request=new Request(url,{method:req.method,headers:req.headers,...(body?{body}:{})});
    const result=await route[req.method](request);const data=await result.text();
    if(result.status===403)console.log('OWNER_BROWSER_AUTH_DENIAL',req.method,{origin:req.headers.origin,url:url.origin,hasBearer:!!req.headers.authorization,production:process.env.VERCEL_ENV});
    if(dropNextRenewal&&req.method==='POST'&&JSON.parse(body).trialAction==='renew_paused_window'&&result.ok){dropNextRenewal=false;droppedResponse=true;req.socket.destroy();return;}
    res.writeHead(result.status,Object.fromEntries(result.headers));res.end(data);
   }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;process.env.NEXT_PUBLIC_SUPABASE_URL=origin;
  const get=async(token='synthetic-owner')=>fetch(origin+'/api/projects/organization?projectId='+original.project,{headers:token?{Authorization:'Bearer '+token}:{}});
  const initialResponse=await get();assert.equal(initialResponse.status,200,await initialResponse.clone().text());
  const initial=(await initialResponse.json()).managementActivation;
  assert.equal(initial.stage,'renew');assert.equal(initial.cutoff,cutoff);assert.equal(initial.status,'paused');
  assert.equal((await get(null)).status,403);assert.equal((await get('other-owner')).status,403);
  const post=async(body,headers={})=>fetch(origin+'/api/projects/organization',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-owner',Origin:origin,...headers},body:JSON.stringify(body)});
  const renewal={trialAction:'renew_paused_window',projectId:original.project,releaseSha:activeRelease,expectedReleaseSha:original.release,scopeHash:original.scope,sourceMissionId:original.source,priorWindowId:original.window,priorCutoff:prior,cutoff,authorizationId:crypto.randomUUID(),stateHash:initial.stateHash};
  const snapshot=async()=>{
   const r=(await db.query("select jsonb_build_object('missions',(select jsonb_agg(to_jsonb(m) order by id) from agent_missions m where project_id=$1),'assignments',(select jsonb_agg(to_jsonb(j) order by j.id) from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1),'nodes',(select jsonb_agg(to_jsonb(n)-'deadline' order by id) from project_organization_nodes n where project_id=$1),'grants',(select jsonb_agg(to_jsonb(g) order by node_id) from project_organization_scope_grants g join project_organization_nodes n on n.id=g.node_id where n.project_id=$1),'limits',(select jsonb_build_object('maxMissions',max_missions,'tokens',token_allowance,'scope',approved_hash,'spec',spec) from work_projects where id=$1)) s",[original.project])).rows[0].s;return r;
  };
  const before=await snapshot();
  const clockNow=Date.now;Date.now=()=>Date.parse(cutoff);
  try{assert.equal((await post(renewal)).status,409,'The approved cutoff cannot be silently extended');}
  finally{Date.now=clockNow;}

  for(const patch of [{releaseSha:'f'.repeat(40)},{stateHash:'f'.repeat(64)},{cutoff:'2026-11-17T18:00:00Z'},{projectId:x.owner},{ownerId:x.owner},{sourceMissionId:x.owner},{priorWindowId:x.owner}]){
   const response=await post({...renewal,...patch});assert.ok([400,409].includes(response.status),JSON.stringify(patch));
  }
  assert.equal((await post(renewal,{Origin:'https://wrong-origin.test'})).status,403);
  assert.equal((await post(renewal,{Authorization:''})).status,403);
  assert.equal((await post(renewal,{Authorization:'Bearer other-owner'})).status,403);
  for(const env of ['preview','development']){process.env.VERCEL_ENV=env;assert.equal((await post(renewal)).status,403);}process.env.VERCEL_ENV='production';
  assert.deepEqual(await snapshot(),before);
  browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundled.executablePath(),args:bundled.args.filter(arg=>arg!=='--disable-web-security'),headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'America/Chicago'});
  for(const session of ['missing','wrong']){
   const page=await context.newPage();await page.goto(origin+'/control?session='+session);await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('button').count(),0);await page.close();
  }
  await db.query('savepoint browser_success');
  const page=await context.newPage();const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));await page.goto(origin+'/control');
  const renewButton=page.getByRole('button',{name:'Renew to approved noon Central cutoff'});await renewButton.waitFor();
  const beforePagePosts=posts;await page.reload();await renewButton.waitFor();assert.equal(posts,beforePagePosts,'No activation on load or refresh');
  assert.equal(await page.getByRole('button',{name:'Resume approved project management'}).count(),0);
  assert.equal(await page.locator('input').count(),0,'No arbitrary cutoff field');
  await page.screenshot({path:join(evidenceDir,'01-paused.png'),fullPage:true});
  assert.ok((await renewButton.boundingBox()).height>=44);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const beforeClicks=posts;await renewButton.evaluate(button=>{button.click();button.click();});
  await page.getByText('Renewal receipt verified for all 13 contracts. Project paused; management has not resumed.').waitFor({timeout:5000}).catch(async error=>{throw Error(error.message+' BODY: '+await page.locator('body').innerText());});
  await page.screenshot({path:join(evidenceDir,'02-renewed-paused.png'),fullPage:true});
  assert.equal(posts,beforeClicks+1,'Double click creates one request');
  assert.equal((await db.query('select status from work_projects where id=$1',[original.project])).rows[0].status,'paused');
  assert.deepEqual(await snapshot(),before);
  assert.equal((await db.query('select count(*)::int n from project_organization_contract_changes where window_id=(select authorization_id from project_paused_window_renewals where project_id=$1)',[original.project])).rows[0].n,13);
  const renewed=(await (await get()).json()).managementActivation;
  assert.equal((await post({...renewal,authorizationId:renewed.authorizationId,stateHash:'f'.repeat(64)})).status,409,'A recorded renewal still rejects a forged original fingerprint');
  // Receipt verification fails closed if any preserved contract has changed.
  await db.query('savepoint changed_contract');await db.query('reset role');
  await db.query("set local session_replication_role='replica'");
  await db.query("update project_organization_nodes set tools=array_append(tools,'research') where id=(select id from project_organization_nodes where project_id=$1 and kind='worker' order by id limit 1)",[original.project]);
  await db.query("set local session_replication_role='origin'");await db.query('set role service_role');
  assert.equal((await get()).status,409,'Changed delegated contracts cannot expose resume');
  await db.query('rollback to savepoint changed_contract');await db.query('release savepoint changed_contract');

  // A still-submitted external task must block both preflight and resume,
  // even when its historical mission/assignment has already failed.
  await db.query('savepoint pending_dispatch');await db.query('reset role');
  await db.query("set local session_replication_role='replica'");
  const taskChat=crypto.randomUUID();
  const taskAgent=(await db.query("select a.* from managed_agents a join project_organization_nodes n on n.agent_id=a.id where n.project_id=$1 and n.kind='worker' order by n.id limit 1",[original.project])).rows[0];
  await db.query("insert into chats(id,actor_id,title) values($1,$2,'Synthetic pending-dispatch fixture')",[taskChat,taskAgent.actor_id]);
  await db.query("insert into agent_tasks(id,agent_id,actor_id,chat_id,snapshot,definition_version,kind,initial_input,input,request_id,status) values($1,$2,$3,$4,$5,$6,'general','Synthetic pending task','Synthetic pending task',$7,'submitted')",[x.source.job,taskAgent.id,taskAgent.actor_id,taskChat,taskAgent.config,taskAgent.version,crypto.randomUUID()]);
  await db.query("set local session_replication_role='origin'");await db.query('set role service_role');
  assert.equal((await get()).status,409,'Submitted external work cannot expose resume');
  assert.equal((await post({trialAction:'resume_management',projectId:original.project,releaseSha:activeRelease,cutoff,authorizationId:renewed.authorizationId,stateHash:renewed.stateHash})).status,409,'Submitted external work cannot race resume');
  await db.query('rollback to savepoint pending_dispatch');await db.query('release savepoint pending_dispatch');
  assert.equal((await post({...renewal,authorizationId:renewed.authorizationId})).status,200,'Retry verifies recorded renewal');
  assert.equal((await db.query('select count(*)::int n from project_paused_window_renewals where project_id=$1',[original.project])).rows[0].n,1);
  const postsBeforeReload=posts;await page.reload();await page.getByRole('button',{name:'Resume approved project management'}).waitFor();assert.equal(posts,postsBeforeReload,'Reload never resumes');
  const resume={trialAction:'resume_management',projectId:original.project,releaseSha:activeRelease,cutoff,authorizationId:renewed.authorizationId,stateHash:renewed.stateHash};
  for(const patch of [{stateHash:initial.stateHash},{authorizationId:crypto.randomUUID()},{releaseSha:'f'.repeat(40)},{cutoff:'2026-11-17T18:00:00Z'}])assert.ok([400,409].includes((await post({...resume,...patch})).status));
  // A real final SQL write failure rolls back resume while retaining renewal.
  await db.query('reset role');
  await db.query("create function pg_temp.reject_browser_resume() returns trigger language plpgsql as $$begin if new.event='management_resume_authorized' then raise exception 'synthetic final resume failure';end if;return new;end$$");
  await db.query('create trigger reject_browser_resume before insert on project_events for each row execute function pg_temp.reject_browser_resume()');await db.query('set role service_role');
  await page.getByRole('button',{name:'Resume approved project management'}).click();await page.getByRole('alert').filter({hasText:'project remains paused'}).waitFor();
  await page.screenshot({path:join(evidenceDir,'03-resume-rejected.png'),fullPage:true});
  assert.equal((await db.query('select count(*)::int n from project_management_resume_receipts where project_id=$1',[original.project])).rows[0].n,0);assert.deepEqual(await snapshot(),before);
  await db.query('reset role');await db.query('drop trigger reject_browser_resume on project_events');await db.query('set role service_role');
  await page.getByRole('button',{name:'Resume approved project management'}).evaluate(button=>{button.click();button.click();});
  await page.getByText('Management resume recorded. Current project status: running.').waitFor();
  assert.deepEqual(await snapshot(),before);assert.equal((await post(resume)).status,409,'Stale resume fingerprint cannot be replayed');
  const resumed=(await (await get()).json()).managementActivation;
  assert.equal((await post({...resume,stateHash:resumed.stateHash})).status,200,'A refreshed recorded receipt does not restart work');
  assert.equal((await db.query('select count(*)::int n from project_management_resume_receipts where project_id=$1',[original.project])).rows[0].n,1);
  await page.screenshot({path:join(evidenceDir,'04-resumed.png'),fullPage:true});
  const counts=(await db.query("select (select count(*)::int from agent_missions where project_id=$1) missions,(select count(*)::int from project_paused_window_renewals where project_id=$1) renewal_receipts,(select count(*)::int from project_management_resume_receipts where project_id=$1) resume_receipts,(select count(*)::int from project_organization_contract_changes where window_id=$2) deadline_receipts,(select count(*)::int from project_work_packages where project_id=$1) coding_packages",[original.project,renewed.authorizationId])).rows[0];
  const git=arg=>spawnSync('git',['rev-parse',arg],{encoding:'utf8'}).stdout.trim();
  writeFileSync(join(evidenceDir,'qualification.json'),JSON.stringify({kind:'isolated engineering qualification',commit:git('HEAD'),tree:git('HEAD^{tree}'),worktreeClean:spawnSync('git',['status','--porcelain'],{encoding:'utf8'}).stdout.trim()==='',sourceFiles:Object.fromEntries(['components/director-recovery-control.tsx','app/api/projects/organization/route.ts','app/api/projects/route.ts','lib/projects/management-activation.ts','supabase/migrations/20261116132333_owner_management_activation_controls.sql'].map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')])),nativePostgres:(await db.query('select version() v')).rows[0].v,viewport:{width:390,height:844},cutoff,counts,originalHistoryPreserved:true,liveActivation:false,providerCalls:0,dispatches:0},null,2));
  assert.equal(await page.getByRole('button',{name:'Resume approved project management'}).count(),0);assert.ok(!(await page.locator('body').innerText()).includes('synthetic-owner'));
  assert.deepEqual(pageErrors,[]);await page.close();
  await db.query('rollback to savepoint browser_success');await db.query('release savepoint browser_success');
  // A committed renewal with a lost HTTP response is discovered by GET. It
  // exposes resume as a separate click, never an automatic retry/dispatch.
  const lost=await context.newPage();await lost.goto(origin+'/control');await lost.getByRole('button',{name:'Renew to approved noon Central cutoff'}).waitFor();
  dropNextRenewal=true;await lost.getByRole('button',{name:'Renew to approved noon Central cutoff'}).click();await lost.getByRole('button',{name:'Resume approved project management'}).waitFor();
  assert.equal(droppedResponse,true);assert.equal((await db.query('select status from work_projects where id=$1',[original.project])).rows[0].status,'paused');
  assert.equal((await db.query('select count(*)::int n from project_management_resume_receipts where project_id=$1',[original.project])).rows[0].n,0);
  await lost.close();
  assert.ok(calls.some(c=>c.name==='project_org_resume_management_confirmed'));assert.ok(calls.every(c=>c.args.p_owner===x.owner));
  console.log('OWNER_MANAGEMENT_BROWSER_POSTGRES_PASS: real mobile control → HTTP route → verified owner auth → native PostgreSQL; separate renewal/resume, 13 contracts, wrong owner/origin/state/release/cutoff, double clicks, reload, receipt retry, lost response and final-write rollback; unchanged 73/96, 600000 tokens, no inference or dispatch');
 }finally{
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
  for(const k of ['VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','KATIE_OWNER_AUTH_USER_ID','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY']){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
  await db.query('rollback to savepoint owner_browser_fixture');await db.query('release savepoint owner_browser_fixture');await db.query('set role service_role');rmSync(scratch,{recursive:true,force:true});
 }
}
