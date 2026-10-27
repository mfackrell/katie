export type QualificationPayload={version:1;phase:"prepare"|"commit";authorization:string;runId:string;runAttempt:number;sha:string;expiresAt:number;transfer:Record<string,unknown>|null};
export function signQualification(payload:QualificationPayload,key:string|undefined):string;
export function readQualification(envelope:string,key:string|undefined,now?:number):QualificationPayload;
export function verifyOwnerRun(input:{payload:QualificationPayload;run:unknown;comment:unknown;workflow:unknown;checks:unknown[];jobs:unknown[];deployedSha:string|undefined;config:unknown}):QualificationPayload;
