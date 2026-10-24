// Explicit benchmark-only mission provider wrapper. Standard missions use
// existing atomic mission reservations unchanged. The caller must supply a
// trusted database and an independently validated benchmark binding.
import {durableBenchmarkAdapter} from '../../scripts/benchmark/durable-adapter.mjs';
import {requireBenchmarkBinding} from './benchmark-binding.mjs';
export async function executeBenchmarkMissionProvider({
 db,binding,missionId,baselineSha,requestId,model,maxInputTokens,maxOutputTokens,invoke
}){
 const grant=requireBenchmarkBinding(binding,{missionId,arm:'orchestrated',baselineSha});
 if(typeof invoke!=='function')throw Error('BENCHMARK_PROVIDER_UNAVAILABLE');
 return durableBenchmarkAdapter(db,grant.accountId).execute({
  requestId,model,maxInputTokens,maxOutputTokens,invoke
 });
}
