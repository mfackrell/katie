import {spawnSync,spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseProjectContext} from './project-context.mjs';
import {sandboxArgs} from './project-sandbox.mjs';
// This entry point and its sibling tools come from the preserved main artifact,
// never from the writable candidate. Candidate commands run only in bwrap.
export async function verifyProject({request,output,workspace=process.cwd()}){
 const context=parseProjectContext(readFileSync(request,'utf8'));if(!context)throw Error('Project verifier requires owner-approved project context');
 const root=resolve(workspace),tools=dirname(fileURLToPath(import.meta.url)),deps=resolve(dirname(tools),'project-dependencies');
 if(tools.startsWith(root+'/')||deps.startsWith(root+'/'))throw Error('Trusted verifier/dependencies must be outside candidate checkout');
 execFileSync('git',['-c','core.fsmonitor=false','diff','--no-ext-diff','--quiet',context.baseSha,'HEAD','--',':(glob)**/package.json',':(glob)**/package-lock.json',':(glob)**/.npmrc','package.json','package-lock.json','.npmrc'],{cwd:root,timeout:10000});
 if(existsSync(deps))rmSync(deps,{recursive:true,force:true});mkdirSync(deps,{recursive:true});
 // Dependency data comes from the previous verified commit. Ignore all install
 // scripts, hide host files, and allow network only for this npm download stage.
 const archive=spawnSync('git',['archive',context.baseSha],{cwd:root,maxBuffer:128*1024*1024,timeout:30000});if(archive.status)throw Error('Unable to read verified baseline dependencies');
 const extracted=spawnSync('tar',['-xf','-','--no-same-owner','-C',deps],{input:archive.stdout,timeout:30000});if(extracted.status)throw Error('Baseline extraction failed');
 // The package tree is extracted from the immutable, verified base commit,
 // and the candidate's dependency manifests were compared byte-for-byte above.
 // Fetch dependency tarballs in this trusted preparation stage, with scripts
 // disabled. The nested bwrap npm installer could not resolve registry packages
 // on GitHub's ephemeral runner ("Exit handler never called"), despite the
 // repository's regular npm ci succeeding. No generated application code runs
 // here, and no provider credentials are passed to the installer.
 const install=spawnSync('npm',['ci','--ignore-scripts','--no-audit','--no-fund','--no-progress'],{
  cwd:deps,stdio:'inherit',timeout:300000,
  env:{
   PATH:process.env.PATH??'/usr/bin:/bin',
   HOME:process.env.RUNNER_TEMP??'/tmp',
   TMPDIR:process.env.RUNNER_TEMP??'/tmp',
   CI:'true',
   npm_config_ignore_scripts:'true',
   npm_config_audit:'false',
   npm_config_fund:'false',
  },
 });
 if(install.status!==0)throw Error('Trusted baseline dependency preparation failed; candidate tests were not run');
 const dependencies=resolve(deps,'node_modules');mkdirSync(resolve(root,'node_modules'),{recursive:true});
 const script="const {spawnSync}=require('node:child_process');for(const task of ['typecheck','ci:gate']){const r=spawnSync('npm',['run',task],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);} ";
 const checkArgs=[...sandboxArgs(root,{dependencies,writable:true}), '--setenv','CI','true','--setenv','VERCEL_ENV','development','--setenv','NEXT_PUBLIC_SUPABASE_URL','https://example.supabase.co','--setenv','NEXT_PUBLIC_SUPABASE_ANON_KEY','anon-placeholder','--setenv','SUPABASE_SERVICE_ROLE_KEY','service-role-placeholder',process.execPath,'-e',script];
 const checked=spawnSync('bwrap',checkArgs,{stdio:'inherit',timeout:1200000});if(checked.status!==0)throw Error('Isolated project CI failed');
 execFileSync('git',['-c','core.fsmonitor=false','diff','--no-ext-diff','--exit-code','HEAD','--'],{cwd:root,timeout:10000});
 // Tools resolve only immutable baseline dependencies, inaccessible to tests.
 const modulePath=resolve(tools,'node_modules');if(existsSync(modulePath))rmSync(modulePath,{recursive:true,force:true});symlinkSync(dependencies,modulePath,'dir');
 const {checkProject}=await import(pathToFileURL(resolve(tools,'project-browser-check.mjs')).href);
 const result=await checkProject({request:resolve(request),port:3109,output:resolve(output),dependencies});
 if(!result?.passed)throw Error('Approved integrated browser acceptance failed');return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const a=process.argv.slice(2);if(a.length!==4||a[0]!=='--request'||a[2]!=='--output')throw Error('Usage: project-ci.mjs --request ORIGINAL --output REPORT');await verifyProject({request:a[1],output:a[3]});}catch(e){console.error(String(e.message).slice(0,1000));process.exitCode=1;}}
