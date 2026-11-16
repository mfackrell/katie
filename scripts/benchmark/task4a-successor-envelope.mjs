// A hard, owner-selected bootstrap envelope, NOT an empirical review forecast
// or a promise of completion. These helpers neither mint nor authenticate consent.
export const TASK4A_SUCCESSOR_ENVELOPE = Object.freeze({
 version:'task4a-successor-envelope-v1',
 projectId:'6d1c29f1-b31e-47a5-aabb-cbcf1326f388',
 taskId:'d0e41ff5-149e-4319-9e65-dcc605fb75da',
 checkpointSha:'d2610d94289a0ba5aafcaa60598cae7c21507cfe',
 basis:'owner_selected_historical_maximum_reservation_not_forecast',
 model:'gpt-5.3-codex',
 requestTokens:23034,nativeCalls:6,nativeReservationTokens:138204,
 outputTokens:4096,protocolTokens:1024,inputAndOpaqueTokens:17914,
 additionalNativeTokens:115954,additionalProjectTokens:136129,additionalCalls:2,
 cumulativeTokens:405574,developmentTokens:345574,developmentCalls:22,
 continuationTokens:258204,continuationCalls:18,continuationMicrousd:7394515,
 carriedProjectReservationTokens:64920,carriedProjectReservationMicrousd:1499654,
 assessmentReserveTokens:60000,completionReserveTokens:60000,
 ceilingMicrousd:9000000,perCallMicrousd:1680000,
 nativeRequestBoundMicrousd:322476,nativeEnvelopeBoundMicrousd:1934856,
 projectRequestBoundMicrousd:532086,projectEnvelopeBoundMicrousd:3192516,
 durationSeconds:14400,
});
const deny=()=>{throw Error('TASK4A_SUCCESSOR_ENVELOPE_DENIED');};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
export function validateTask4aSuccessorEnvelope(envelope){
 if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))deny();
 const keys=Object.keys(TASK4A_SUCCESSOR_ENVELOPE);
 if(Object.keys(envelope).length!==keys.length||keys.some(k=>!Object.hasOwn(envelope,k)||envelope[k]!==TASK4A_SUCCESSOR_ENVELOPE[k]))deny();
 return TASK4A_SUCCESSOR_ENVELOPE;
}
// Call only after the host has authenticated the approval and successor claim.
// Absence preserves ordinary behavior; an invalid present marker fails closed.
export function task4aSuccessorRequestCap({approval,defaultCap}){
 if(!integer(defaultCap)||defaultCap<1)deny();
 const authority=approval?.developer_authority;
 if(!authority||!Object.hasOwn(authority,'task4aSuccessorEnvelope'))return defaultCap;
 const envelope=validateTask4aSuccessorEnvelope(authority.task4aSuccessorEnvelope);
 return Math.min(defaultCap,envelope.requestTokens);
}
export function assertTask4aSuccessorRequest({envelope,inputTokens,opaqueTokens=0,outputTokens=4096}){
 const policy=validateTask4aSuccessorEnvelope(envelope);
 if(!integer(inputTokens)||!integer(opaqueTokens)||!integer(outputTokens)||outputTokens<1||outputTokens>policy.outputTokens)deny();
 const inputAndOpaque=inputTokens+opaqueTokens;
 const reservationTokens=inputAndOpaque+outputTokens+policy.protocolTokens;
 if(!integer(inputAndOpaque)||!integer(reservationTokens)||inputAndOpaque>policy.inputAndOpaqueTokens||reservationTokens>policy.requestTokens)deny();
 return reservationTokens;
}
