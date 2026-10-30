export interface NativeDispatchPayload {
 resourceAmendmentId?:string;paidSuccessorId?:string;pregrantRecoveryId?:string;developmentRenewalId?:string;startupRecoveryId?:string;productionRuntime?:string;continuationId?:string;
 taskId:string;trialId:string;approvalId:string;projectId:string;
 contractHash:string;benchmarkContractHash:string;baselineSha:string;expiresAt:number;
}
export function encodeNativeHandoff(payload:NativeDispatchPayload,key:string):string;
export function readNativeHandoff(source:string,key:string,now?:number):
 Readonly<NativeDispatchPayload & {version:1}>;


