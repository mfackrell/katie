// Real Native/Thin Take Eleven execution. Uses the SAME contained Codex SDK,
// provider HTTP bridge and atomic benchmark journal as Full. No candidate
// process receives GitHub, database or upstream model credentials.
import {createClient} from '@supabase/supabase-js';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,cpSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createNonFullTrustedGateway} from './nonfull-trusted-gateway.mjs';
import {createResponsesProvider} from './native-provider-receipts.mjs';
import {verifyNonFullLaunch} from './arm-launch-authority.mjs';
import {assertBenchmarkDollarCeiling} from './paid-dollar-ceiling.mjs';
import {sharedNativeContainerArgs} from './shared-native-container.mjs';
import {assertTrustedBoundary,protectedNativeMounts,protectedGitConfig} from './native-trust-boundary.mjs';
const STAGE='https://iytvavgbaainnsrecmcx.supabase.co';
const REPO='mfackrell/katie';
const BASELINE='0015bcdb8ac9ad94b7c74d1a4cd76737903b1319';
const MODEL='gpt-5.3-codex';
const CAP=350000;
const PRICE=28000000;
const reject=reason=>{throw Error('BENCHMARK_PAID_RUN_DENIED:'+reason)};
function git(cwd,...args){
 return execFileSync('git',[...protectedGitConfig,...args],{
  cwd,encoding:'utf8',timeout:30000,
  env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',GH_TOKEN:process.env.GH_TOKEN??''}
 }).trim();
}
async function lookup(db,table,id){
 const {data,error}=await db.from(table).select('*').eq('id',id).maybeSingle();
 if(error||!data)reject('record:'+table);return data;
}
const allowedFile=name=>name.startsWith('app/project-pilots/take-eleven/')||
 name==='tests/game-development/take-eleven.test.mjs';
function assertScope(cwd){
 const names=git(cwd,'status','--porcelain','--untracked-files=all').split('\n').filter(Boolean)
  .map(line=>line.slice(3).split(' -> ').at(-1));
 if(names.some(name=>!allowedFile(name)))reject('out-of-contract-path');
 const changes=git(cwd,'diff','--name-only',BASELINE).split('\n').filter(Boolean);
 if(changes.some(name=>!allowedFile(name)))reject('changed-out-of-contract-path');
}
async function runPhase({arm,phase,boundary,socketdir,token,model,requestPath,childPath,hostRoot,findings}){
 const reviewing=phase==='review'||phase==='final-review';
 const out=join(hostRoot,'review-findings.txt');
 if(findings)writeFileSync(out,findings,{mode:0o600});
 const command='socat TCP-LISTEN:43181,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/gateway/gateway.sock & p=$!; trap "kill $p 2>/dev/null || :" EXIT; node /trusted/native-development-child.mjs';
 const mounts=[
  ...protectedNativeMounts(boundary),'--dir','/trusted',
  '--ro-bind',childPath,'/trusted/native-development-child.mjs',
  '--ro-bind',join(process.cwd(),'scripts/benchmark/shared-native-phase.mjs'),'/trusted/shared-native-phase.mjs',
  '--ro-bind',join(process.cwd(),'scripts/benchmark/shared-native-policy.mjs'),'/trusted/shared-native-policy.mjs',
  '--ro-bind',requestPath,'/trusted/AGENT_REQUEST.md',
  ...(findings?['--ro-bind',out,'/trusted/review-findings.txt']:[])
 ];
 const args=sharedNativeContainerArgs({workspace:boundary.root,socketDir:socketdir,
  arm,phase,command,readOnly:reviewing,extraMounts:mounts,
  extraEnv:['--setenv','KATIE_NATIVE_MODEL',model,
   '--setenv','KATIE_NATIVE_BRIDGE_TOKEN',token,
   '--setenv','KATIE_NATIVE_BASELINE_SHA',BASELINE]});
 const child=spawn('bwrap',args,{env:{PATH:process.env.PATH??''},stdio:['ignore','pipe','pipe']});
 let output='',errors='';
 child.stdout.on('data',part=>{output=(output+part).slice(-28000);process.stdout.write(part)});
 child.stderr.on('data',part=>{errors=(errors+part).slice(-5000);process.stderr.write(part)});
 const outcome=await new Promise((resolve,rej)=>{
  child.once('error',rej);child.once('close',(code,signal)=>resolve({code,signal}));
 });
 if(outcome.code!==0)reject('phase-'+phase+':'+errors.slice(-500));
 if(reviewing){
  const line=output.split('\n').findLast(x=>x.startsWith('NATIVE_REVIEW_RESULT='));
  let review;try{review=JSON.parse(line?.slice('NATIVE_REVIEW_RESULT='.length))}catch{reject('review-receipt-missing')}
  if(review.phase!==phase||!['pass','changes_requested'].includes(review.verdict)||!review.findings?.trim())
   reject('review-verdict-invalid');
  return review;
 }
 return {phase,verdict:'finished'};
}
function writeContract(arm){
 const intro='Take Eleven original v1: exactly 11 stones; player A begins. Legal take 1,2,3 not exceeding remaining. Last taker wins. Invalid, unknown and post-win actions preserve entire state. Pure transition function separate from persistence/UI. localStorage restores in-progress and finished games and reset. Accessible Take 1/2/3 and Reset buttons with visible stones, player, phase and winner. Scope ONLY app/project-pilots/take-eleven/ and tests/game-development/take-eleven.test.mjs. Run deterministic unit tests and browser acceptance. No production publication, no dependencies, no secrets, no unrelated files. Original source GitHub issue #650.\n';
 const armText=arm==='thin'?
 'THIN KATIE treatment: Before implementation, state a short plan and checkpoint acceptance. Use a bounded implementation/review/repair cycle and preserve verified work. Do not add project managers or create extra orchestration.\n':
 'NATIVE treatment: Implement directly with native engineering tools without Katie orchestration guidance.\n';
 return intro+armText;
}
export async function executePaidNonfull({db,ownerId,arm,trial,account,approval,
 providerKey,checkout=process.cwd(),childFile=join(process.cwd(),'scripts/benchmark/native-development-child.mjs'),
 onCompleted=()=>{}}){
 if(!['native','thin'].includes(arm)||trial.replicate!==2||trial.baseline_sha!==BASELINE||
  trial.arm!==arm||Number(account.cap_tokens)!==CAP||Number(account.spent_tokens)!==0||
  approval.model!==MODEL||approval.max_tokens!=CAP)reject('trial-parity');
 verifyNonFullLaunch({arm,trial,account,approval,ownerId,repository:REPO});
 const price=await db.from('model_registry')
  .select('pricing_status,pricing_input_per_1m,pricing_output_per_1m')
  .eq('provider_name','openai').eq('model_id',MODEL).maybeSingle();
 if(price.error||price.data?.pricing_status!=='verified')reject('model-pricing');
 assertBenchmarkDollarCeiling({armUsdCents:1000,priceCeilingMicrosPerMillion:PRICE,
  publishedInputUsdPerMillion:price.data.pricing_input_per_1m,
  publishedOutputUsdPerMillion:price.data.pricing_output_per_1m,
  accountTokens:Number(account.cap_tokens),approvalTokens:Number(approval.max_tokens)});
 const root=mkdtempSync(join(tmpdir(),'benchmark-real-'+arm+'-'));
 const workspace=join(root,'repo'),sockdir=join(root,'sock');mkdirSync(sockdir);
 let server,confirmed=false;
 const notes=[],issuedAt=Date.now();
 try{
  execFileSync('git',['clone','--no-hardlinks','--quiet',checkout,workspace],{timeout:45000});
  git(workspace,'checkout','--detach',BASELINE);
  git(workspace,'switch','-c','benchmark/715-paid-'+arm+'-'+trial.id.slice(0,8));
  // Copy *trusted installed dependencies*. Never symlink shared host deps to
  // writable candidate workspace; the container mounts node_modules read-only.
  cpSync(join(checkout,'node_modules'),join(workspace,'node_modules'),{recursive:true,dereference:false});
  const boundary=assertTrustedBoundary(workspace);
  const requestPath=join(root,'take-eleven-owner-request.md');
  writeFileSync(requestPath,writeContract(arm),{mode:0o600});
  const upstream=createResponsesProvider({apiKey:providerKey});
  const bridgeToken=randomBytes(32).toString('base64url');
  const gateway=await createNonFullTrustedGateway({db,arm,trial,account,approval,
   ownerId,repository:REPO,upstream,clientToken:bridgeToken,upperTokens:20000,
   providerNamespace:'openai-responses'});
  server=gateway.server;
  await new Promise(resolve=>server.listen(join(sockdir,'gateway.sock'),resolve));
  const phase=async(name,findings='')=>runPhase({arm,phase:name,boundary,socketdir,
    token:bridgeToken,model:MODEL,requestPath,childPath:childFile,hostRoot:root,findings});
  await phase('implementation');
  assertScope(workspace);
  git(workspace,'add','-A');
  git(workspace,'-c','user.name=Katie Benchmark','-c','user.email=katie-benchmark@users.noreply.github.com',
   'commit','--allow-empty','-m','Take Eleven: native implementation');
  const firstReview=await phase('review');notes.push(firstReview);
  if(firstReview.verdict==='changes_requested'){
   await phase('repair',firstReview.findings);
   assertScope(workspace);
   git(workspace,'add','-A');
   git(workspace,'-c','user.name=Katie Benchmark','-c','user.email=katie-benchmark@users.noreply.github.com',
    'commit','--allow-empty','-m','Take Eleven: independent review repair');
  }
  const finalReview=await phase('final-review');notes.push(finalReview);
  if(finalReview.verdict!=='pass')reject('final-independent-review-not-pass');
  assertScope(workspace);
  const deterministic=spawn('node',['--test','tests/game-development/take-eleven.test.mjs'],
   {cwd:workspace,stdio:'inherit',env:{PATH:process.env.PATH??'',HOME:root}});
  const testExit=await new Promise((resolve,reject)=>{deterministic.once('error',reject);deterministic.once('close',resolve)});
  if(testExit!==0)reject('deterministic-acceptance-failed');
  const head=git(workspace,'rev-parse','HEAD');
  if(!process.env.GH_TOKEN)reject('durable-checkpoint-token-missing');
  execFileSync('gh',['auth','setup-git'],{env:{PATH:process.env.PATH??'',GH_TOKEN:process.env.GH_TOKEN}});
  git(workspace,'push','origin','HEAD:refs/heads/benchmark/715-paid-'+arm+'-'+trial.id.slice(0,8));
  const {error:statusError}=await db.from('benchmark_three_arm_trials')
   .update({state:'submitted'}).eq('id',trial.id).eq('state','running');
  if(statusError)reject('submission-status-not-committed');
  confirmed=true;
  const result={arm,trialId:trial.id,accountId:account.id,commitSha:head,
   branch:'benchmark/715-paid-'+arm+'-'+trial.id.slice(0,8),
   deterministicTestsPassed:true,independentFinalReview:'pass',
   privateBrowserAcceptance:'not-yet-verified',paid:true,
   currency:'USD',priceUpperPerMillion:28,tokenCap:CAP,
   reviewCycles:notes.length,wallMs:Date.now()-issuedAt};
  onCompleted(result);
  return result;
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
}
if(process.argv[1]?.endsWith('paid-staging-nonfull-runner.mjs')){
 if(process.env.KATIE_BENCHMARK_PAID_EXECUTION!=='enabled'||process.env.GITHUB_REPOSITORY!==REPO||
  process.env.GITHUB_ACTOR?.toLowerCase()!==process.env.GITHUB_REPOSITORY_OWNER?.toLowerCase()||
  process.env.KATIE_NONFULL_STAGING_SUPABASE_URL!==STAGE||
  process.env.KATIE_NONFULL_PRODUCTION_SUPABASE_URL===STAGE||
  !process.env.OPENAI_API_KEY||!process.env.KATIE_NONFULL_STAGING_SERVICE_ROLE_KEY)
  reject('owner-runtime-not-attested');
 const [,,manifestPath,arm,output]=process.argv;
 const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
 if(manifest.replicate!==2||manifest.allowedPaidUsdCents!==3000||
   manifest.conservativeMicrosPerMillion!==PRICE)reject('manifest-budget-mismatch');
 const row=manifest.arms.find(x=>x.arm===arm);
 if(!row?.approvalId||row.tokenCap!==CAP)reject('arm-approval-missing');
 const db=createClient(STAGE,process.env.KATIE_NONFULL_STAGING_SERVICE_ROLE_KEY,
  {auth:{persistSession:false,autoRefreshToken:false}});
 const [trial,account,approval]=await Promise.all([
  lookup(db,'benchmark_three_arm_trials',row.trialId),
  lookup(db,'benchmark_budget_accounts',row.accountId),
  lookup(db,'benchmark_native_spending_approvals',row.approvalId)]);
 const result=await executePaidNonfull({db,ownerId:process.env.KATIE_NONFULL_STAGING_OWNER_ID,
  arm,trial,account,approval,providerKey:process.env.OPENAI_API_KEY});
 writeFileSync(output,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log('BENCHMARK_REAL_NATIVE_THIN_SUBMITTED_'+arm);
}
