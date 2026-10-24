// Controllable direct-provider entrypoint for a bounded benchmark MODEL CALL.
// Repository execution permissions must be implemented separately; this module
// never shells out to a coding agent or confers access to files.
import {durableBenchmarkAdapter} from './durable-adapter.mjs';
export async function directMeteredModelCall({db,accountId,requestId,model,maxInputTokens,maxOutputTokens,provider}){
 if(typeof provider!=='function')throw Error('DIRECT_PROVIDER_UNAVAILABLE');
 const meter=durableBenchmarkAdapter(db,accountId);
 return meter.execute({requestId,model,maxInputTokens,maxOutputTokens,
  invoke:({model,maxOutputTokens,reservationId})=>provider({model,maxOutputTokens,reservationId})});
}
