// Real Codex SDK subprocess with synthetic responses; invoked only inside bwrap.
import {Codex} from '@openai/codex-sdk';
import {executeSharedNativePhase} from './shared-native-phase.mjs';
import {NATIVE_GATEWAY_URL,nativeCodexConfig,assertNativeEffectivePolicy} from './shared-native-policy.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const phase=process.env.KATIE_NATIVE_PHASE;
assert(['implementation','review','repair','final-review'].includes(phase));
assert.equal(process.env.KATIE_OUTER_SANDBOX_CONFIRMED,'1');
assert.equal(process.env.OPENAI_API_KEY,undefined);
assert.equal(process.env.KATIE_BENCHMARK_SERVICE_ROLE_KEY,undefined);
assert.equal(process.env.GH_TOKEN,undefined);
const home='/tmp/native-four-phase',state=join(home,'.codex');
mkdirSync(state,{recursive:true});
const url=NATIVE_GATEWAY_URL;
writeFileSync(join(state,'config.toml'),nativeCodexConfig(url));
const arm=process.env.KATIE_BENCHMARK_ARM;
assertNativeEffectivePolicy({gateway:url,model:'synthetic',arm,phase});
const {completed,reviewMessage:message}=await executeSharedNativePhase({
 Codex,arm,phase,gateway:url,bearer:'contained-fixture-token',model:'synthetic',
 home,state,root:'/work',prompt:'Contained qualification phase: '+phase,
 onEvent:event=>{if(event.type==='turn.failed')console.error('CONTAINED_SYNTHETIC_TURN_FAILURE',String(event.error?.message||event.error?.code||'unknown').slice(0,300))}
});
assert(completed,'CONTAINED_PHASE_INCOMPLETE:'+phase);
if(phase==='review')assert.match(message,/^CHANGES_REQUESTED/);
if(phase==='final-review')assert.match(message,/^PASS/);
console.log('CONTAINED_PHASE_PASS='+phase);
