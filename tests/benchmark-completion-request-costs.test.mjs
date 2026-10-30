import test from 'node:test';
import assert from 'node:assert/strict';
import {admitNativeRequest} from '../scripts/benchmark/native-request-admission.mjs';
const base={model:'gpt-5.3-codex',input:[],max_output_tokens:4096};
test('native request pins standard tier and rejects every hosted tool before reservation',()=>{
 const accepted=admitNativeRequest({...base,tools:[{type:'namespace',name:'functions',tools:[{type:'function',name:'exec_command',parameters:{type:'object'}}]},{type:'custom',name:'apply_patch'}]});
 assert.equal(accepted.body.service_tier,'default');
 for(const type of ['web_search','web_search_preview','file_search','code_interpreter','computer','image_generation','mcp'])assert.throws(()=>admitNativeRequest({...base,tools:[{type}]}),/TOOL_COST_UNBOUNDED/);
 for(const service_tier of ['priority','flex','auto',null])assert.throws(()=>admitNativeRequest({...base,service_tier}),/SERVICE_TIER_DENIED/);
 assert.throws(()=>admitNativeRequest({...base,tools:[{type:'namespace',name:'functions',tools:[{type:'web_search'}]}]}),/TOOL_COST_UNBOUNDED/);
});
