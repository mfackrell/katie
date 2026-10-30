// Operational count-only qualification of actual SDK first requests captured in
// a separate credential-free job. Never generate a response or replay opaque data.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createResponsesProvider} from './native-provider-receipts.mjs';
import {admitNativeRequest} from './native-request-admission.mjs';
import {assertNativeRequestTools} from './shared-native-policy.mjs';
const phases=['implementation','review','repair','final-review'];
export async function qualifySdkInputCounts(raw,count){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>2_000_000)throw Error('SDK_COUNT_FIXTURE_SIZE');
 let entries;try{entries=JSON.parse(raw);}catch{throw Error('SDK_COUNT_FIXTURE_JSON');}
 if(!Array.isArray(entries)||entries.length!==4)throw Error('SDK_COUNT_FIXTURE_PHASES');
 // Validate every request before any operational call. Unknown/opaque context
 // never reaches the count API; production admission remains the authority.
 const bodies=entries.map((entry,i)=>{
  if(!entry||entry.phase!==phases[i]||entry.body?.model!=='gpt-5.3-codex')throw Error('SDK_COUNT_FIXTURE_IDENTITY');
  const body=entry.body;
  if(Array.isArray(body.input)&&body.input.some(item=>item?.type==='reasoning'))throw Error('SDK_COUNT_FIXTURE_REPLAY');
  assertNativeRequestTools(body);return admitNativeRequest(body).body;
 });
 const results=[];
 for(let i=0;i<bodies.length;i++){
  const result=await count(bodies[i]);
  if(!Number.isSafeInteger(result?.inputTokens)||result.inputTokens<0)throw Error('SDK_COUNT_RESULT_INVALID');
  results.push({phase:phases[i],model:'gpt-5.3-codex',inputTokens:result.inputTokens,payloadBytes:Buffer.byteLength(JSON.stringify(bodies[i]))});
 }
 return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(!process.env.RUNNER_TEMP)throw Error('SDK_COUNT_FIXTURE_DIRECTORY');
 const raw=readFileSync(join(process.env.RUNNER_TEMP,'native-sdk-first-count-requests.json'),'utf8');
 const provider=createResponsesProvider({apiKey:process.env.OPENAI_API_KEY});
 const results=await qualifySdkInputCounts(raw,body=>provider.countInputTokens(body));
 for(const result of results)console.log('ACTUAL_SDK_PROVIDER_INPUT_COUNT='+JSON.stringify(result));
}
