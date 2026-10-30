// Trusted SDK bootstrap: invoked inside the isolated repository worktree.
// No Supabase service role or upstream provider secret enters this process.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {summarizeNativeEvent,worktreeEvidence} from '/trusted/native-execution-evidence.mjs';
import {executeSharedNativePhase,assertNativeArmPhase} from '/trusted/shared-native-phase.mjs';
import {NATIVE_GATEWAY_URL,nativeCodexConfig,assertNativeEffectivePolicy} from '/trusted/shared-native-policy.mjs';
// Public ESM entry of the pinned SDK; CommonJS resolution rejects its import-only exports.
import {Codex} from '/work/node_modules/@openai/codex-sdk/dist/index.js';
if(process.argv[2]==='--preflight'){
 if(typeof Codex!=='function')throw Error('NATIVE_SDK_EXPORT_MISSING');
 process.stdout.write('NATIVE_CHILD_PREFLIGHT_OK\n');
 process.exit(0);
}
const arm=process.env.KATIE_BENCHMARK_ARM;
const phase=process.env.KATIE_NATIVE_PHASE||'implementation';
assertNativeArmPhase(arm,phase);
const baseline=process.env.KATIE_NATIVE_BASELINE_SHA;
if(!/^[a-f0-9]{40}$/.test(baseline??''))throw Error('NATIVE_BASELINE_MISSING');
const root='/work',home='/tmp/native-home',state=join(home,'.codex');
mkdirSync(state,{recursive:true});
const gateway=NATIVE_GATEWAY_URL;
writeFileSync(join(state,'config.toml'),nativeCodexConfig(gateway));
const bearer=process.env.KATIE_NATIVE_BRIDGE_TOKEN;
const model=process.env.KATIE_NATIVE_MODEL;
assertNativeEffectivePolicy({gateway,model,arm,phase});
if(!bearer||!model||process.env.KATIE_OUTER_SANDBOX_CONFIRMED!=='1')
 throw Error('NATIVE_WORKER_NOT_ATTESTED');
const prompts={
 implementation:'Read the immutable owner request at /trusted/AGENT_REQUEST.md. Complete the approved engineering work within the permitted paths. Run tests. Do not publish, merge or deploy.',
 review:'You are a fresh independent reviewer. Read the immutable owner request at /trusted/AGENT_REQUEST.md and inspect all uncommitted changes and tests against the approved request. Do not edit any file. Your FINAL reply must start with precisely PASS or CHANGES_REQUESTED, followed by actionable findings. Never say PASS if you cannot independently verify requirements and scope.',
 repair:'Read the immutable owner request at /trusted/AGENT_REQUEST.md and /trusted/review-findings.txt. Fix only the independent reviewer findings in approved scope. Run tests. Do not publish, merge, deploy or bypass accounting.',
 'final-review':'You are a fresh independent reviewer. Read the immutable owner request at /trusted/AGENT_REQUEST.md and inspect all current changes and tests. Do not edit. Your FINAL reply must start with precisely PASS or CHANGES_REQUESTED, followed by actionable findings. Request changes if prior findings remain.'
};
const reviewing=phase==='review'||phase==='final-review';
const anchored=reviewing?prompts[phase]+' Independently inspect the complete diff with git diff '+baseline+'...HEAD. Verify that commit HEAD contains all reviewed changes.':prompts[phase];
const {reviewMessage}=await executeSharedNativePhase({
 Codex,arm,phase,gateway,bearer,model,home,state,root,prompt:anchored,
 onEvent:event=>{const safe=summarizeNativeEvent(event,[bearer]);if(safe&&event.type==='item.completed'&&['command_execution','file_change'].includes(event.item?.type))safe.worktree=worktreeEvidence(root,[bearer]);if(safe)process.stdout.write('NATIVE_EXECUTION_EVENT='+JSON.stringify(safe)+'\n');}
});
if(phase==='review'||phase==='final-review'){
 const verdict=/^PASS(?:\s|$)/.test(reviewMessage.trim())?'pass':'changes_requested';
 process.stdout.write('NATIVE_REVIEW_RESULT='+JSON.stringify({phase,verdict,findings:reviewMessage.slice(0,12000)})+'\n');
}else process.stdout.write('NATIVE_DEVELOPMENT_RETURNED_FOR_INDEPENDENT_VERIFICATION\n');

