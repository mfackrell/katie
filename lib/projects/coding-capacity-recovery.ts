import {rpc} from '@/lib/missions/store';
import {ORIGINAL_TTT_PROJECT,ORIGINAL_TTT_SCOPE} from './management-activation';
import {preflightManagementContext} from './management-context-preflight';

export type CodingCapacityOffer={
 stage:'authorize'|'authorized';projectId:string;authorizationId:string|null;authorizedAt?:string;
 releaseSha:string;releaseGeneration:number;deploymentId:string;scopeHash:string;paths:string[];cutoff:string;
 historicalMissions:96|98|99|102;priorMaxMissions:96|100|101|102;remainingMissions:number;tokenAllowance:600000;recordedTokens:number;
 priorAuthorizationId?:string;sourceMissionId?:string;sourceAssignmentId?:string;failure?:string;
 coderId?:string;writerId?:string;reviewerId?:string;
 remainingRecordedTokens:number;nodeCount:13|15;retryLimit:0;stateHash:string;directorId:string;managerId:string;status:string;
 minAdditionalMissions?:number;recommendedAdditionalMissions?:number;maxAdditionalMissions?:number;
 additionalMissions?:number;maxMissions?:number;paidInferenceLimit?:number;packageId?:string|null;
 providerRequestsAtApproval:number;providerRequestsNow?:number;historicalInferenceRequests?:number;
 directorContextChars?:number;managerContextChars?:number;
};
const paths=['app/milestone-3-tic-tac-toe/','lib/milestone-3-tic-tac-toe/','tests/milestone-3-tic-tac-toe/'];
export async function codingCapacityOffer(projectId:string):Promise<CodingCapacityOffer>{
 const sha=process.env.VERCEL_GIT_COMMIT_SHA;
 if(projectId!==ORIGINAL_TTT_PROJECT||process.env.VERCEL_ENV!=='production'||!sha||!/^[a-f0-9]{40}$/.test(sha))
  throw Error('Current original production release required');
 const o=await rpc<CodingCapacityOffer>('project_org_coding_capacity_offer',{p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:sha});
 if(!o||o.projectId!==projectId||o.releaseSha!==sha||o.deploymentId!==process.env.VERCEL_DEPLOYMENT_ID
  ||o.scopeHash!==ORIGINAL_TTT_SCOPE||JSON.stringify(o.paths)!==JSON.stringify(paths)
  ||!((o.historicalMissions===96&&o.priorMaxMissions===96)||(o.historicalMissions===98&&o.priorMaxMissions===100)||(o.historicalMissions===99&&o.priorMaxMissions===101)||(o.historicalMissions===102&&o.priorMaxMissions===102))||o.nodeCount!==(o.historicalMissions===102?15:13)||o.tokenAllowance!==600000||o.retryLimit!==0
  ||!Number.isSafeInteger(o.releaseGeneration)||o.releaseGeneration<1||!Number.isFinite(Date.parse(o.cutoff))
  ||!Number.isSafeInteger(o.recordedTokens)||o.recordedTokens<0||o.remainingRecordedTokens!==600000-o.recordedTokens
  ||!/^[a-f0-9]{64}$/.test(o.stateHash)||!['authorize','authorized'].includes(o.stage))
  throw Error('Original commissioning recovery offer changed');
 const resumed=o.historicalMissions!==96,identityRecovery=o.historicalMissions===99,finalPackage=o.historicalMissions===102;
 const count=finalPackage?1:3;
 if(finalPackage&&(o.coderId!=='08e792df-1046-4282-89dc-83994a8a6b7e'||o.writerId!==o.coderId||o.reviewerId!=='1cf12044-d9ba-4e8b-9ef4-8b7e5aa004a5'))
  throw Error('Exact existing commissioned worker roles required');
 if(resumed&&(!o.priorAuthorizationId
  ||o.sourceMissionId!==(finalPackage?'3094d990-a16e-498b-bfb3-1a37245069c7':identityRecovery?'43af2c7c-0b7c-48e6-a247-016e599f3349':'5bd4b72d-cd8b-4425-a6dd-16fdcfd346d7')
  ||o.sourceAssignmentId!==(finalPackage?'51274624-c601-4d66-826e-c635bb026e65':identityRecovery?'fb7c3e64-64ba-4612-9bba-a4084c11aafe':'3cf41309-6f35-4c68-8e75-7da55d5669c6')
  ||o.additionalMissions!==count||o.maxMissions!==o.historicalMissions+count||o.paidInferenceLimit!==count))
  throw Error('Exact signed commissioning continuation terms required');
 if(o.stage==='authorized'){
  if(!o.authorizationId||!Number.isSafeInteger(o.additionalMissions)||Number(o.additionalMissions)<1||Number(o.additionalMissions)>8
   ||o.maxMissions!==o.historicalMissions+Number(o.additionalMissions)||o.paidInferenceLimit!==o.additionalMissions)
   throw Error('Signed capacity receipt unavailable');
  return {...o,cutoff:new Date(o.cutoff).toISOString()};
 }
 if(o.authorizationId!==null||o.status!=='blocked'||(resumed
  ?o.remainingMissions!==(finalPackage?0:2)||o.minAdditionalMissions!==count||o.recommendedAdditionalMissions!==count||o.maxAdditionalMissions!==count||!o.failure
  :o.remainingMissions!==0||o.minAdditionalMissions!==1||o.recommendedAdditionalMissions!==4||o.maxAdditionalMissions!==8))
  throw Error('Original exhausted-project state changed');
 const [d,m]=await Promise.all([resumed?Promise.resolve(null):preflightManagementContext(projectId,o.directorId),preflightManagementContext(projectId,o.managerId,!finalPackage,finalPackage)]);
 if(m.inputLimit!==48000||m.chars>48000||m.organizationNodes!==o.nodeCount||m.principalId!==o.managerId
  ||(finalPackage&&(m.packageRoles?.workerId!==o.coderId||m.packageRoles?.writerId!==o.writerId||m.packageRoles?.reviewerId!==o.reviewerId||m.packageRoles?.milestoneIndex!==0||JSON.stringify(m.packageRoles?.paths)!==JSON.stringify(o.paths)))
  ||(d&&(d.inputLimit!==48000||d.chars>48000||d.organizationNodes!==13||d.principalId!==o.directorId)))throw Error('Complete current commissioning context does not fit');
 return {...o,cutoff:new Date(o.cutoff).toISOString(),directorContextChars:d?.chars,managerContextChars:m.chars};
}
