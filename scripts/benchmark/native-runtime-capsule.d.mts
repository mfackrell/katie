import type {NativeDispatchPayload} from './native-dispatch-contract.mjs';
export function sealNativeProductionRuntime(serviceRoleKey:string,proof:NativeDispatchPayload,key:string,now?:number):string;
export function openNativeProductionRuntime(value:string,proof:NativeDispatchPayload,key:string,now?:number):{url:string;serviceRoleKey:string};
