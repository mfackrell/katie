export type DeveloperDispatchPayload={version?:1;authorityKind:'ordinary-developer';taskId:string;projectId:string;approvalId:string;accountId:string;scopeHash:string;contractHash:string;baselineSha:string;releaseSha:string;expiresAt:number;productionRuntime?:string};
export function encodeDeveloperHandoff(payload:DeveloperDispatchPayload,key:string,now?:number):string;
export function readDeveloperHandoff(source:string,key:string,now?:number):Readonly<DeveloperDispatchPayload>;
