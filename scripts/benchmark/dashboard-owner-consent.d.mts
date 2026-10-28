export function sealDashboardHandoff(payload:{consentId:string;sha:string;expiresAt:number;bypass:string},key:string|undefined):string;
export function openDashboardHandoff(value:string,key:string|undefined,sha:string,now?:number):{consentId:string;sha:string;expiresAt:number;bypass:string};
export function validateDashboardConsent(consent:unknown,identity:{id:string;ownerId:string|undefined;sha:string;runId:string;authorizationSha:string},now?:number):boolean;
