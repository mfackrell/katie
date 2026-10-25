// Real Codex SDK subprocess with synthetic responses; invoked only inside bwrap.
import {Codex} from '@openai/codex-sdk';
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
const url='http://127.0.0.1:43181/v1';
writeFileSync(join(state,'config.toml'),
 'model_provider = "contained_fixture"\n[model_providers.contained_fixture]\nname = "Contained fixture"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nbase_url = "'+url+'"\nrequest_max_retries = 0\nstream_max_retries = 0\n');
const codex=new Codex({baseUrl:url,apiKey:'contained-fixture-token',env:{
 PATH:process.env.PATH||'',HOME:home,CODEX_HOME:state,CODEX_SQLITE_HOME:state,
 CODEX_API_KEY:'contained-fixture-token'
}});
const thread=codex.startThread({workingDirectory:'/work',skipGitRepoCheck:false,
 sandboxMode:phase==='review'||phase==='final-review'?'read-only':'danger-full-access'});
const {events}=await thread.runStreamed('Contained qualification phase: '+phase);
let completed=false,message='';
for await(const event of events){
 if(event.type==='turn.completed')completed=true;
 if(event.type==='turn.failed')throw Error('CONTAINED_PHASE_FAILED:'+phase);
 if(event.type==='item.completed'&&event.item?.type==='agent_message')
  message=event.item.text;
}
assert(completed,'CONTAINED_PHASE_INCOMPLETE:'+phase);
if(phase==='review')assert.match(message,/^CHANGES_REQUESTED/);
if(phase==='final-review')assert.match(message,/^PASS/);
console.log('CONTAINED_PHASE_PASS='+phase);
