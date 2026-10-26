// Runs ONLY inside the contained SDK worker. No database or provider key.
import {Codex} from '@openai/codex-sdk';
import {mkdirSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const repo=process.env.KATIE_TEST_REPO,port=Number(process.env.KATIE_TEST_GATEWAY_PORT);
assert(repo&&port&&process.env.KATIE_OUTER_SANDBOX_CONFIRMED==='1');
const home='/tmp/codex-home',state=join(home,'.codex');
mkdirSync(state,{recursive:true});
const base='http://127.0.0.1:'+port+'/v1';
writeFileSync(join(state,'config.toml'),
 'model_provider = "synthetic_http"\n[model_providers.synthetic_http]\nname = "Synthetic HTTP"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nbase_url = "'+base+'"\nrequest_max_retries = 0\nstream_max_retries = 0\n');
const codex=new Codex({baseUrl:base,apiKey:'synthetic-fixture-token',
 env:{PATH:process.env.PATH||'',HOME:home,CODEX_HOME:state,CODEX_SQLITE_HOME:state,
 CODEX_API_KEY:'synthetic-fixture-token'}});
const thread=codex.startThread({workingDirectory:repo,skipGitRepoCheck:false,
 sandboxMode:'danger-full-access'});
let completed=false;
const {events}=await thread.runStreamed('Create native-tool.txt containing NATIVE_TOOL_OK with shell and verify it.');
for await(const event of events)if(event.type==='turn.completed')completed=true;
assert(completed,'EXTERNAL_GATEWAY_NATIVE_INCOMPLETE');
assert(existsSync(join(repo,'native-tool.txt')),'NATIVE_TOOL_MISSING');
assert.equal(readFileSync(join(repo,'native-tool.txt'),'utf8'),'NATIVE_TOOL_OK');
console.log('EXTERNAL_NATIVE_SDK_TOOL_PASS');
