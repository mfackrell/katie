// Trusted SDK bootstrap: invoked inside the isolated repository worktree.
// No Supabase service role or upstream provider secret enters this process.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const require=createRequire('/work/package.json');
const {Codex}=await import(pathToFileURL(require.resolve('@openai/codex-sdk')).href);
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
 sandboxMode:'danger-full-access',model});
let completed=false;
const {events}=await thread.runStreamed(
 'Read AGENT_REQUEST.md. Complete the approved engineering work within the permitted paths. Run tests. Do not publish, merge or deploy.');
for await(const event of events){
 if(event.type==='thread.started')process.stdout.write('NATIVE_THREAD='+JSON.stringify(event)+'\n');
 if(event.type==='turn.failed')throw Error('NATIVE_TURN_FAILED');
 if(event.type==='turn.completed')completed=true;
}
if(!completed)throw Error('NATIVE_TURN_INCOMPLETE');
process.stdout.write('NATIVE_DEVELOPMENT_RETURNED_FOR_INDEPENDENT_VERIFICATION\n');
