export const TASK4A_FAILED_RUN: Readonly<Record<string,string|number>>;
export function task4aLinkedRecoveryTask<T>(task:T,evidence:Record<string,unknown>):T;
export function authenticateTask4aFailedRun(options:{task:unknown;github:(path:string,binary?:boolean)=>Promise<any>}):Promise<Record<string,unknown>>;
export function loadTask4aLinkedDiagnostics(options:{task:unknown;evidence:Record<string,unknown>;github:(path:string,binary?:boolean)=>Promise<any>}):Promise<any>;
