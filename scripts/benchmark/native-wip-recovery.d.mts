export type NativeRecoveryRecord={checkpointSha:string;ref:string;taskId:string;projectId:string;originalBaselineSha:string;approvedScopeHash:string;runId:string;sourceTreeSha:string;completedCheckpointSha:string;[key:string]:unknown};
export function loadRecoveryDiagnostics(input:Record<string,unknown>):Promise<{record:NativeRecoveryRecord|null;diagnostics:{capacityObservations?:unknown[];[key:string]:unknown}}>;
export function recoveryCompletedEvidence(record:NativeRecoveryRecord,diagnostics:unknown):unknown;
export function validateRecoveryRecords(input:Record<string,unknown>):Promise<unknown>;
