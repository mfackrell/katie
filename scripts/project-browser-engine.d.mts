export type AcceptanceCheck={name:string;passed:boolean;detail:string};
export type PreviewCookie={name:string;value:string;domain:string;path:string;httpOnly:boolean;secure:boolean;sameSite:'Lax'|'Strict'|'None';expires?:number};
export function localRequestAllowed(raw:string,origin:string,method?:string):boolean;
export function runScenarios(contract:unknown,origin:string,options?:{executablePath?:string;timeout?:number;deployed?:boolean;cookies?:PreviewCookie[];proxy?:{server:string;username?:string;password?:string}}):Promise<AcceptanceCheck[]>;

export function platformToolbar(raw:string,type:string,deployed:boolean):boolean;
