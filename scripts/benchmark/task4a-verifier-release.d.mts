export const TASK4A_HANDOFF_BASELINE:string;
export const TASK4A_HANDOFF_WORKFLOWS:string[];
export type Task4aVerifierReleaseEvidence={version:string;repository:string;baselineSha:string;releaseSha:string;qualifiedHeadSha:string;treeSha:string;pullRequest:number;checks:{workflow:string;workflowId:number;runId:number;attempt:number;headSha:string}[]};
export function authenticateTask4aVerifierRelease(release:string,read:(path:string)=>Promise<any>):Promise<Task4aVerifierReleaseEvidence>;
