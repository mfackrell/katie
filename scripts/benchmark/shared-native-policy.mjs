// Frozen engineering capability contract for Native, Thin, Full.
// Arm differences belong to orchestration, never native model/tool privileges.
export const NATIVE_GATEWAY_URL='http://127.0.0.1:43181/v1';
export const NATIVE_GATEWAY_PORT=43181;
export const NATIVE_SDK_VERSION='0.164.0';
export const NATIVE_RUNTIME_POLICY=Object.freeze({
 wireApi:'responses',maxRetries:0,streamRetries:0,
 hostedTools:false,networkAccess:'gateway-only',
 sdkVersion:NATIVE_SDK_VERSION
});
export function nativeCodexConfig(gateway=NATIVE_GATEWAY_URL){
 if(gateway!==NATIVE_GATEWAY_URL)throw Error('NATIVE_GATEWAY_POLICY_MISMATCH');
 return [
  'model_provider = "contained_gateway"',
  '[model_providers.contained_gateway]',
  'name = "Contained gateway"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'supports_websockets = false',
  'base_url = "'+gateway+'"',
  'request_max_retries = 0',
  'stream_max_retries = 0',
  ''
 ].join('\n');
}
export function assertNativeEffectivePolicy({gateway,model,arm,phase}){
 if(!['native','thin','full'].includes(arm))throw Error('NATIVE_ARM_INVALID');
 if(!['implementation','review','repair','final-review'].includes(phase))throw Error('NATIVE_PHASE_INVALID');
 if(gateway!==NATIVE_GATEWAY_URL||typeof model!=='string'||!model.trim())
  throw Error('NATIVE_EFFECTIVE_POLICY_DENIED');
 return NATIVE_RUNTIME_POLICY;
}

export function assertNativeRequestTools(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.model!=='string')
  throw Error('NATIVE_REQUEST_INVALID');
 if(body.tools!==undefined){
  if(!Array.isArray(body.tools)||body.tools.length>100)
   throw Error('NATIVE_TOOLS_INVALID');
  for(const tool of body.tools){
   // Codex-native function/custom tool calls execute in the contained worker.
   // Provider-hosted network, MCP, browser and external shell tools are denied.
   if(!tool||!['function','custom'].includes(tool.type))
    throw Error('NATIVE_REMOTE_PROVIDER_TOOL_DENIED:'+String(tool?.type||'missing').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40));
  }
 }
 return true;
}
