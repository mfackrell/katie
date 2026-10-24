// A benchmark mission must carry a trusted server-issued binding. Ordinary
// missions never acquire benchmark privileges from user text or model output.
export function requireBenchmarkBinding(binding,{missionId,arm,baselineSha}) {
 if(!binding||binding.verifiedByServer!==true||binding.missionId!==missionId||
    binding.arm!==arm||!['direct','orchestrated'].includes(arm)||
    binding.baselineSha!==baselineSha||typeof baselineSha!=='string'||
    !/^[0-9a-f]{40}$/.test(baselineSha)||
    typeof binding.accountId!=='string'||!binding.accountId||
    typeof binding.experimentId!=='string'||!binding.experimentId)
  throw Error('BENCHMARK_BINDING_UNVERIFIED');
 return Object.freeze({accountId:binding.accountId,experimentId:binding.experimentId,
    missionId,arm,baselineSha});
}
export function benchmarkMissionGate({binding,missionId,arm,baselineSha,ordinaryReserve,benchmarkReserve}) {
 if(binding==null) return ordinaryReserve;
 const authorized=requireBenchmarkBinding(binding,{missionId,arm,baselineSha});
 if(typeof benchmarkReserve!=='function')throw Error('BENCHMARK_RESERVE_UNAVAILABLE');
 return async request=>benchmarkReserve(authorized,request);
}
