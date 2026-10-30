import {createHmac,timingSafeEqual} from 'node:crypto';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha=/^[a-f0-9]{40}$/;
const hash=/^[a-f0-9]{64}$/;
export function encodeNativeHandoff(payload,key){
 if(!key||key.length<32)throw Error('NATIVE_HANDOFF_KEY_UNAVAILABLE');
 if(!payload||(payload.resourceAmendmentId!==undefined&&(!uuid.test(payload.resourceAmendmentId)||!payload.developmentRenewalId||payload.paidSuccessorId||payload.pregrantRecoveryId||payload.startupRecoveryId))||(payload.paidSuccessorId!==undefined&&(!uuid.test(payload.paidSuccessorId)||!payload.developmentRenewalId||payload.pregrantRecoveryId||payload.startupRecoveryId))||(payload.pregrantRecoveryId!==undefined&&(!uuid.test(payload.pregrantRecoveryId)||!payload.developmentRenewalId||payload.startupRecoveryId))||(payload.developmentRenewalId!==undefined&&!uuid.test(payload.developmentRenewalId))||(payload.startupRecoveryId!==undefined&&!uuid.test(payload.startupRecoveryId))||(payload.continuationId!==undefined&&!uuid.test(payload.continuationId))||!['taskId','trialId','approvalId','projectId'].every(k=>uuid.test(payload[k]??''))||
    !hash.test(payload.contractHash??'')||!hash.test(payload.benchmarkContractHash??'')||!sha.test(payload.baselineSha??'')||
    !Number.isSafeInteger(payload.expiresAt)||payload.expiresAt<=Date.now())
  throw Error('NATIVE_HANDOFF_INVALID');
 const frozen={version:1,taskId:payload.taskId,trialId:payload.trialId,
  approvalId:payload.approvalId,projectId:payload.projectId,
  contractHash:payload.contractHash,benchmarkContractHash:payload.benchmarkContractHash,
  baselineSha:payload.baselineSha,expiresAt:payload.expiresAt,
  ...(payload.pregrantRecoveryId?{pregrantRecoveryId:payload.pregrantRecoveryId}:{}),
  ...(payload.resourceAmendmentId?{resourceAmendmentId:payload.resourceAmendmentId}:{}),
  ...(payload.paidSuccessorId?{paidSuccessorId:payload.paidSuccessorId}:{}),
  ...(payload.developmentRenewalId?{developmentRenewalId:payload.developmentRenewalId}:{}),
  ...(payload.startupRecoveryId?{startupRecoveryId:payload.startupRecoveryId}:{}),
  ...(payload.continuationId?{continuationId:payload.continuationId}:{}),
  ...(payload.productionRuntime?{productionRuntime:payload.productionRuntime}:{})};
 const content=Buffer.from(JSON.stringify(frozen)).toString('base64url');
 const signature=createHmac('sha256',key).update(content).digest('base64url');
 return '<!-- katie-native-benchmark:'+content+'.'+signature+' -->';
}
export function readNativeHandoff(source,key,now=Date.now()){
 const matches=[...String(source).matchAll(/<!-- katie-native-benchmark:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+) -->/g)];
 if(matches.length!==1)throw Error('NATIVE_HANDOFF_MISSING_OR_DUPLICATED');
 if(!key||key.length<32)throw Error('NATIVE_HANDOFF_KEY_UNAVAILABLE');
 const content=matches[0][1],signature=matches[0][2];
 const expected=createHmac('sha256',key).update(content).digest();
 const actual=Buffer.from(signature,'base64url');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))
  throw Error('NATIVE_HANDOFF_UNAUTHENTICATED');
 let p;try{p=JSON.parse(Buffer.from(content,'base64url').toString('utf8'))}
 catch{throw Error('NATIVE_HANDOFF_INVALID')}
 if(p.version!==1||(p.resourceAmendmentId!==undefined&&(!uuid.test(p.resourceAmendmentId)||!p.developmentRenewalId||p.paidSuccessorId||p.pregrantRecoveryId||p.startupRecoveryId))||(p.paidSuccessorId!==undefined&&(!uuid.test(p.paidSuccessorId)||!p.developmentRenewalId||p.pregrantRecoveryId||p.startupRecoveryId))||(p.pregrantRecoveryId!==undefined&&(!uuid.test(p.pregrantRecoveryId)||!p.developmentRenewalId||p.startupRecoveryId))||(p.developmentRenewalId!==undefined&&!uuid.test(p.developmentRenewalId))||(p.startupRecoveryId!==undefined&&!uuid.test(p.startupRecoveryId))||(p.continuationId!==undefined&&!uuid.test(p.continuationId))||!['taskId','trialId','approvalId','projectId'].every(k=>uuid.test(p[k]??''))||
    !hash.test(p.contractHash??'')||!hash.test(p.benchmarkContractHash??'')||!sha.test(p.baselineSha??'')||
    !Number.isSafeInteger(p.expiresAt)||p.expiresAt<=now||
    (p.productionRuntime!==undefined&&(typeof p.productionRuntime!=='string'||p.productionRuntime.length>8192||! /^[A-Za-z0-9_-]+$/.test(p.productionRuntime)))||
    Object.keys(p).sort().join()!==[...(p.resourceAmendmentId!==undefined?['resourceAmendmentId']:[]),...(p.paidSuccessorId!==undefined?['paidSuccessorId']:[]),...(p.pregrantRecoveryId!==undefined?['pregrantRecoveryId']:[]),...(p.developmentRenewalId!==undefined?['developmentRenewalId']:[]),...(p.startupRecoveryId!==undefined?['startupRecoveryId']:[]),...(p.continuationId!==undefined?['continuationId']:[]),...(p.productionRuntime!==undefined?['productionRuntime']:[]),'version','taskId','trialId','approvalId','projectId','contractHash','benchmarkContractHash','baselineSha','expiresAt'].sort().join())
  throw Error('NATIVE_HANDOFF_INVALID');
 return Object.freeze(p);
}


