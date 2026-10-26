import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {NATIVE_GATEWAY_URL,NATIVE_SDK_VERSION,NATIVE_RUNTIME_POLICY,nativeCodexConfig,assertNativeEffectivePolicy,assertNativeRequestTools} from '../scripts/benchmark/shared-native-policy.mjs';
const full=readFileSync('scripts/benchmark/native-development-child.mjs','utf8');
const thin=readFileSync('scripts/benchmark/native-four-phase-contained-client.mjs','utf8');
const host=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
test('all arms use byte-for-byte identical gateway config and SDK policy',()=>{
 assert.equal(NATIVE_GATEWAY_URL,'http://127.0.0.1:43181/v1');
 assert.equal(NATIVE_SDK_VERSION,'0.164.0');
 assert.equal(NATIVE_RUNTIME_POLICY.hostedTools,false);
 for(const arm of ['native','thin','full']){
  for(const phase of ['implementation','review','repair','final-review']){
   assert.equal(assertNativeEffectivePolicy({gateway:NATIVE_GATEWAY_URL,model:'synthetic',arm,phase}),NATIVE_RUNTIME_POLICY);
  }
 }
 assert.equal(nativeCodexConfig(NATIVE_GATEWAY_URL),nativeCodexConfig());
 assert.throws(()=>nativeCodexConfig('https://provider.example/v1'),/GATEWAY_POLICY_MISMATCH/);
 assert.throws(()=>assertNativeEffectivePolicy({gateway:NATIVE_GATEWAY_URL,model:'',arm:'native',phase:'review'}),/POLICY_DENIED/);
});
test('production and fixture workers derive config from the same trusted module',()=>{
 for(const worker of [full,thin]){
  assert.match(worker,/nativeCodexConfig\(/);
  assert.match(worker,/assertNativeEffectivePolicy\(/);
  assert.match(worker,/NATIVE_GATEWAY_URL/);
  assert.doesNotMatch(worker,/model_provider = /);
 }
 assert.match(host,/shared-native-policy\.mjs/);
 const workflow=readFileSync('.github/workflows/autonomous-development.yml','utf8');
 assert.match(workflow,/shared-native-phase,shared-native-policy,shared-native-container\}\.mjs/);
});

test('all three arms use one hardened container launcher and identical filesystem protections',()=>{
 const launcher=readFileSync('scripts/benchmark/shared-native-container.mjs','utf8');
 const fixture=readFileSync('scripts/benchmark/native-four-phase-contained-host-probe.mjs','utf8');
 assert.match(host,/sharedNativeContainerArgs\(/);
 assert.match(fixture,/sharedNativeContainerArgs\(/);
 assert.match(launcher,/--unshare-all','--clearenv/);
 assert.match(launcher,/--bind',socketDir,'\/gateway'/);
 assert.match(launcher,/reviewing\?'--ro-bind':'--bind'/);
 assert.match(host,/protectedNativeMounts\(boundary\)/);
 assert.match(fixture,/protectedNativeMounts\(assertTrustedBoundary\(join\(workRoot,arm\)\)\)/);
});

test('same gateway rejects provider-hosted tools and allows native custom/function tools',()=>{
 assert.equal(assertNativeRequestTools({model:'synthetic',tools:[{type:'custom',name:'exec'},{type:'function',name:'function_call'}]}),true);
 for(const type of ['web_search','web_search_preview','file_search','computer_use_preview','mcp','code_interpreter','shell']){
  assert.throws(()=>assertNativeRequestTools({model:'synthetic',tools:[{type}]}),/REMOTE_PROVIDER_TOOL_DENIED/);
 }
 const gateway=readFileSync('scripts/benchmark/native-http-bridge.mjs','utf8');
 assert.match(gateway,/assertNativeRequestTools\(body\)/);
 assert.match(gateway,/fullMission:typeof fullMission==='function'\?fullMission\(\):fullMission/);
});
