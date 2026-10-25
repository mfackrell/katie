// Trusted SDK bootstrap: invoked inside the isolated repository worktree.
// No Supabase service role or upstream provider secret enters this process.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const require=createRequire('/work/package.json');
const {Codex}=await import(pathToFileURL(require.resolve('@openai/codex-sdk')).href);
const arm=process.env.KATIE_BENCHMARK_ARM;
if(!['native','thin','full'].includes(arm))throw Error('NATIVE_ARM_INVALID');
const phase=process.env.KATIE_NATIVE_PHASE||'implementation';
if(!['implementation','review','repair','final-review'].includes(phase))throw Error('NATIVE_PHASE_INVALID');
const baseline=process.env.KATIE_NATIVE_BASELINE_SHA;
if(!/^[a-f0-9]{40}$/.test(baseline??''))throw Error('NATIVE_BASELINE_MISSING');
const root='/work',home='/tmp/native-home',state=join(home,'.codex');
mkdirSync(state,{recursive:true});
const gateway='http://127.0.0.1:43181/v1';
writeFileSync(join(state,'config.toml'),
 'model_provider = "contained_gateway"\n[model_providers.contained_gateway]\nname = "Contained gateway"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nbase_url = "'+gateway+'"\nrequest_max_retries = 0\nstream_max_retries = 0\n');
const bearer=process.env.KATIE_NATIVE_BRIDGE_TOKEN;
const model=process.env.KATIE_NATIVE_MODEL;
if(!bearer||!model||process.env.KATIE_OUTER_SANDBOX_CONFIRMED!=='1')
 throw Error('NATIVE_WORKER_NOT_ATTESTED');
const codex=new Codex({baseUrl:gateway,apiKey:bearer,env:{
 PATH:process.env.PATH||'',HOME:home,CODEX_HOME:state,CODEX_SQLITE_HOME:state,
 CODEX_API_KEY:bearer}});
const thread=codex.startThread({workingDirectory:root,skipGitRepoCheck:false,
 sandboxMode:phase==='review'||phase==='final-review'?'read-only':'danger-full-access',model});
let completed=false,reviewMessage='';
const prompts={
 implementation:'Read the immutable owner request at /trusted/AGENT_REQUEST.md. Complete the approved engineering work within the permitted paths. Run tests. Do not publish, merge or deploy.',
 review:'You are a fresh independent reviewer. Read the immutable owner request at /trusted/AGENT_REQUEST.md and inspect all uncommitted changes and tests against the approved request. Do not edit any file. Your FINAL reply must start with precisely PASS or CHANGES_REQUESTED, followed by actionable findings. Never say PASS if you cannot independently verify requirements and scope.',
 repair:'Read the immutable owner request at /trusted/AGENT_REQUEST.md and /trusted/review-findings.txt. Fix only the independent reviewer findings in approved scope. Run tests. Do not publish, merge, deploy or bypass accounting.',
 'final-review':'You are a fresh independent reviewer. Read the immutable owner request at /trusted/AGENT_REQUEST.md and inspect all current changes and tests. Do not edit. Your FINAL reply must start with precisely PASS or CHANGES_REQUESTED, followed by actionable findings. Request changes if prior findings remain.'
};
const reviewing=phase==='review'||phase==='final-review';
const anchored=reviewing?prompts[phase]+' Independently inspect the complete diff with git diff '+baseline+'...HEAD. Verify that commit HEAD contains all reviewed changes.':prompts[phase];
const {events}=await thread.runStreamed(anchored);
for await(const event of events){
 if(event.type==='thread.started')process.stdout.write('NATIVE_THREAD='+JSON.stringify(event)+'\n');
 if(event.type==='item.completed'&&event.item?.type==='agent_message'&&typeof event.item.text==='string')reviewMessage=event.item.text;
 if(event.type==='turn.failed')throw Error('NATIVE_TURN_FAILED');
 if(event.type==='turn.completed')completed=true;
}
if(!completed)throw Error('NATIVE_TURN_INCOMPLETE');
if(phase==='review'||phase==='final-review'){
 const verdict=/^PASS(?:\s|$)/.test(reviewMessage.trim())?'pass':'changes_requested';
 process.stdout.write('NATIVE_REVIEW_RESULT='+JSON.stringify({phase,verdict,findings:reviewMessage.slice(0,12000)})+'\n');
}else process.stdout.write('NATIVE_DEVELOPMENT_RETURNED_FOR_INDEPENDENT_VERIFICATION\n');
