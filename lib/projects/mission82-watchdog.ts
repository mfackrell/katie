import {rpc} from '@/lib/missions/store';
import {ORIGINAL_TTT_PROJECT,ORIGINAL_TTT_SCOPE} from './management-activation';

export const MISSION82_ID='53f28eed-631a-4e7e-b868-7b36a34be616' as const;
export const MISSION82_ASSIGNMENT='0e358d94-6f36-4607-998f-e603646d33de' as const;

export type Mission82WatchdogOffer={
 projectId:string;stage:'recover_watchdog'|'recovered'|'claimed'|'completed'|'terminal';
 releaseSha:string;releaseGeneration:number;deploymentId:string;
 missionId:string;assignmentId:string;scopeHash:string;cutoff:string;
 authorizationId:string|null;authorizedAt?:string;
 currentAttempts:number;historicalMissions:number;maxMissions:number;
 tokenAllowance:number;nodeCount:number;stateHash?:string;
};

// Reading this offer never authorizes work. The signed browser POST and
// atomic SQL recovery are the sole path to a fresh watchdog grace period.
export async function mission82WatchdogOffer(projectId:string):Promise<Mission82WatchdogOffer>{
 const sha=process.env.VERCEL_GIT_COMMIT_SHA;
 if(projectId!==ORIGINAL_TTT_PROJECT||process.env.VERCEL_ENV!=='production'
  ||!sha||!/^[0-9a-f]{40}$/.test(sha))
  throw Error('Exact original production recovery release required');
 const offer=await rpc<Mission82WatchdogOffer>('project_org_mission82_watchdog_offer',{
  p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:sha
 });
 if(!offer||offer.projectId!==projectId||offer.releaseSha!==sha
  ||!['recover_watchdog','recovered','claimed','completed','terminal'].includes(offer.stage)
  ||offer.missionId!==MISSION82_ID||offer.assignmentId!==MISSION82_ASSIGNMENT
  ||offer.scopeHash!==ORIGINAL_TTT_SCOPE
  ||!Number.isSafeInteger(offer.releaseGeneration)||offer.releaseGeneration<=0
  ||!/^dpl_[A-Za-z0-9]+$/.test(offer.deploymentId)
  ||!Number.isFinite(Date.parse(offer.cutoff))
  ||offer.historicalMissions!==82||offer.maxMissions!==96||offer.tokenAllowance!==600000
  ||offer.nodeCount!==13||!Number.isSafeInteger(offer.currentAttempts)
  ||offer.currentAttempts<0
  ||(offer.stage==='recover_watchdog'&&(offer.currentAttempts!==0
   ||offer.authorizationId!==null||typeof offer.stateHash!=='string'
   ||!/^[a-f0-9]{64}$/.test(offer.stateHash)))
  ||(offer.stage!=='recover_watchdog'&&(!offer.authorizationId
   ||!/^[0-9a-f-]{36}$/i.test(offer.authorizationId)
   ||!offer.authorizedAt||!Number.isFinite(Date.parse(offer.authorizedAt)))))
  throw Error('Mission82 watchdog owner offer or release mismatch');
 return {...offer,cutoff:new Date(offer.cutoff).toISOString()};
}
