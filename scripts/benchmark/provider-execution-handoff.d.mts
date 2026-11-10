export type ProviderExecutionProof={authorityKind:'provider-execution';taskId:string;projectId:string;scopeHash:string;contractHash:string;baselineSha:string;releaseSha:string;requestHash:string;expiresAt:number;productionRuntime:string};
export function providerExecutionRequestHash(body:string):string;
export function encodeProviderExecutionHandoff(proof:ProviderExecutionProof,key:string,now?:number):string;
export function readProviderExecutionHandoff(source:string,key:string,now?:number):Readonly<ProviderExecutionProof>;
