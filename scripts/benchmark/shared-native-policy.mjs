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
