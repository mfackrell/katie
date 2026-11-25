import {rpc} from '@/lib/missions/store';
import {ORIGINAL_TTT_PROJECT,ORIGINAL_TTT_SCOPE} from './management-activation';
import {preflightManagementContext} from './management-context-preflight';
export const ORIGINAL_PACKAGE='f88d4d10-dfe4-479e-a2cf-41b3e8209e47';
export type PackageExecutionTerms={historicalMissions:104;additionalMissions:8;maxMissions:112;developmentAttempts:3;codingDispatches:3;nativeInferencePerDispatch:12;nativeInferenceLimit:36;compositionLimit:3;reviewLimit:3;managerEvaluationLimit:3;managerRepairLimit:2;paidInferenceLimit:47;automaticRetries:0;nativeAutomaticRepairs:0;tokenAllowance:600000;additionalTokens:0;spendMode:'provider-account';dollarCeilingMicrousd:null;stopAt:'package-acceptance'};
export const PACKAGE_TERMS:PackageExecutionTerms={historicalMissions:104,additionalMissions:8,maxMissions:112,developmentAttempts:3,codingDispatches:3,nativeInferencePerDispatch:12,nativeInferenceLimit:36,compositionLimit:3,reviewLimit:3,managerEvaluationLimit:3,managerRepairLimit:2,paidInferenceLimit:47,automaticRetries:0,nativeAutomaticRepairs:0,tokenAllowance:600000,additionalTokens:0,spendMode:'provider-account',dollarCeilingMicrousd:null,stopAt:'package-acceptance'};
export const CORRECTIVE_TERMS={maxCorrectiveReleases:6,preProviderRetestsOnly:true,additionalPaidRetries:0,qualifiedReleasesOnly:true,samePackageOnly:true} as const;
export type CorrectiveTerms=typeof CORRECTIVE_TERMS;
export function matchesCorrectiveTerms(value:unknown):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>,entries=Object.entries(CORRECTIVE_TERMS);
 return Object.keys(v).length===entries.length&&entries.every(([k,x])=>v[k]===x);
}
export const COMPLETION_TERMS={maxMissions:118,developmentAttempts:5,codingDispatches:5,managerMissions:9,nativeInferencePerDispatch:12,nativeInferenceLimit:60,compositionLimit:5,reviewLimit:5,paidInferenceLimit:80,additionalPaidRetries:1,automaticRetries:0,nativeAutomaticRepairs:0,tokenAllowance:600000,additionalTokens:0,spendMode:'provider-account',dollarCeilingMicrousd:null,stopAt:'package-acceptance'} as const;
export type CompletionTerms=typeof COMPLETION_TERMS;
export function matchesCompletionTerms(value:unknown):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>,entries=Object.entries(COMPLETION_TERMS);
 return Object.keys(v).length===entries.length&&entries.every(([k,x])=>v[k]===x);
}
export type PackageExecutionOffer={stage:'authorize';projectId:string;packageId:string;priorAuthorizationId:string;releaseSha:string;releaseGeneration:number;deploymentId:string;scopeHash:string;cutoff:string;stateHash:string;contractFingerprint:string;managerId:string;coderId:string;writerId:string;reviewerId:string;paths:string[];developmentPaths:string[];terms:PackageExecutionTerms;continuation?:{failedMissionId:string;failedAssignmentId:string;usedMissions:105|106;remainingMissions:7|6;usedAttempts:1;remainingAttempts:2;recordedProviderRequests:0};correctiveTerms?:CorrectiveTerms;contextHash?:string;contextChars?:number;completionTerms?:CompletionTerms;completionCheckpoint?:{missionId:string;assignmentId:string;usedMissions:109;usedAttempts:2;paidInferences:3;priorRequestId:string;priorProviderReceipt:string;correctiveReleasesUsed:number}};
export function matchesPackageTerms(value:unknown):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>,expected=Object.entries(PACKAGE_TERMS);
 return Object.keys(v).length===expected.length&&expected.every(([k,x])=>v[k]===x);
}
export async function packageExecutionOffer(projectId:string):Promise<PackageExecutionOffer>{
 const sha=process.env.VERCEL_GIT_COMMIT_SHA;
 if(projectId!==ORIGINAL_TTT_PROJECT||process.env.VERCEL_ENV!=='production'||!sha||!/^[a-f0-9]{40}$/.test(sha))throw Error('Current original production release required');
 const args={p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:sha};
 let o:PackageExecutionOffer;
 try{o=await rpc<PackageExecutionOffer>('project_org_package_execution_offer',args);}
 catch{try{o=await rpc<PackageExecutionOffer>('project_org_package_release_offer',args);}catch{try{o=await rpc<PackageExecutionOffer>('project_org_package_corrective_offer',args);}catch{o=await rpc<PackageExecutionOffer>('project_org_package_completion_offer',args);}}}
 if(!o||o.stage!=='authorize'||o.projectId!==projectId||o.packageId!==ORIGINAL_PACKAGE||o.releaseSha!==sha||o.deploymentId!==process.env.VERCEL_DEPLOYMENT_ID||o.scopeHash!==ORIGINAL_TTT_SCOPE
 ||!Number.isSafeInteger(o.releaseGeneration)||o.releaseGeneration<1||!Number.isFinite(Date.parse(o.cutoff))||Date.now()>=Date.parse(o.cutoff)-300000
 ||!/^[a-f0-9]{64}$/.test(o.stateHash)||!/^[a-f0-9]{64}$/.test(o.contractFingerprint)||o.coderId!==o.writerId||o.coderId===o.reviewerId||!matchesPackageTerms(o.terms))throw Error('Exact Mission 104 package offer required');
 if(o.completionTerms){
  const c=o.completionCheckpoint;
  if(!matchesCompletionTerms(o.completionTerms)||!c||c.missionId!=='d7e48722-01a0-47ed-81ef-d045a5b09c89'||c.assignmentId!=='ed9182b7-7e95-4678-afb2-b75832c5aeea'||c.usedMissions!==109||c.usedAttempts!==2||c.paidInferences!==3||!matchesCorrectiveTerms(o.correctiveTerms))throw Error('Exact Mission109 completion offer required');
  const context=await preflightManagementContext(projectId,o.managerId,false,false,96000);
  if(context.principalId!==o.managerId||context.inputLimit!==96000||context.chars<1||context.chars>96000||!/^[a-f0-9]{64}$/.test(context.sha256))throw Error('Complete current management context required');
  o={...o,contextHash:context.sha256,contextChars:context.chars};
 }else if(o.correctiveTerms){
  const c=o.continuation;
  if(!matchesCorrectiveTerms(o.correctiveTerms)||!c||c.failedMissionId!=='06908731-09d0-4832-a53c-3f1065214c80'||c.failedAssignmentId!=='9afc323a-07cc-4ebf-9562-be1c208675cf'||c.usedMissions!==106||c.remainingMissions!==6||c.usedAttempts!==1||c.remainingAttempts!==2||c.recordedProviderRequests!==0)throw Error('Exact Mission106 corrective continuation changed');
  const context=await preflightManagementContext(projectId,o.managerId,false,false,96000);
  if(context.principalId!==o.managerId||context.inputLimit!==96000||context.chars<1||context.chars>96000||!/^[a-f0-9]{64}$/.test(context.sha256))throw Error('Complete corrected package context not qualified');
  o={...o,contextHash:context.sha256,contextChars:context.chars};
 }else if(o.continuation&&(o.continuation.failedMissionId!=='a6cf216a-6ef6-46fb-968c-1bac950c916b'||o.continuation.failedAssignmentId!=='4c15dddd-5a3f-481e-87cb-7607902bbd06'||o.continuation.usedMissions!==105||o.continuation.remainingMissions!==7||o.continuation.usedAttempts!==1||o.continuation.remainingAttempts!==2||o.continuation.recordedProviderRequests!==0))throw Error('Exact failed package continuation changed');
 return {...o,cutoff:new Date(o.cutoff).toISOString()};
}
