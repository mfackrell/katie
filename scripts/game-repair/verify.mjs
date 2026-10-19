// Trusted main-branch entry point; candidate commands run without network,
// credentials, host home or writable dependencies inside bubblewrap.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {sandboxArgs} from '../project-sandbox.mjs';
const [planFile,workspace,dependencies,receiptFile]=process.argv.slice(2);
const plan=JSON.parse(readFileSync(planFile,'utf8'));
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim();
const receipt={version:1,game:plan.game,pr:plan.pr,attempt:plan.attempt,sourceSha:plan.sourceSha,headSha:head,startedAt:new Date().toISOString(),passed:false,scope:'built-local-route; deployed acceptance remains a separate delivery gate',checks:[]};
mkdirSync(resolve(workspace,'node_modules'),{recursive:true});
const commands=[
 ['engine',process.execPath,['--experimental-test-isolation=none','--test',plan.config.testFile]],
 ['build',process.execPath,['node_modules/next/dist/bin/next','build']],
 ['browser',process.execPath,['-e',`const{spawn}=require('node:child_process');const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3100'],{stdio:'inherit'});(async()=>{try{let ready=false;for(let i=0;i<60;i++){try{const r=await fetch('http://127.0.0.1:3100/project-pilots/${plan.game}');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,1000))}if(!ready)throw Error('Built route failed to start');const test=spawn(process.execPath,[${JSON.stringify(plan.config.browserFile)}],{stdio:'inherit',env:{...process.env,BEACON_RELAY_ORIGIN:'http://127.0.0.1:3100'}});process.exitCode=await new Promise(r=>test.on('close',r));}catch(e){console.error(e);process.exitCode=1}finally{server.kill('SIGTERM')}})();`]]
];
try{
 for(const[name,command,args]of commands){
  const sandbox=[...sandboxArgs(workspace,{dependencies,writable:true}),...Object.entries({CI:'true',VERCEL_ENV:'development',NEXT_PUBLIC_SUPABASE_URL:'https://example.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'anon-placeholder',SUPABASE_SERVICE_ROLE_KEY:'service-role-placeholder'}).flatMap(([k,v])=>['--setenv',k,v]),command,...args];
  const r=spawnSync('bwrap',sandbox,{encoding:'utf8',timeout:600000,maxBuffer:15*1024*1024});
  const check={name,command:[command,...args],exitCode:r.status,signal:r.signal,output:(r.stdout??'')+(r.stderr??''),error:r.error?.message};receipt.checks.push(check);console.log(check.output);
  if(r.status!==0)throw Error('Failed '+name);
 }
 execFileSync('git',['diff','--exit-code','HEAD','--'],{cwd:workspace});receipt.passed=true;
}catch(error){receipt.error=String(error.message);}
finally{receipt.completedAt=new Date().toISOString();writeFileSync(receiptFile,JSON.stringify(receipt,null,2));}
if(!receipt.passed)process.exitCode=1;
