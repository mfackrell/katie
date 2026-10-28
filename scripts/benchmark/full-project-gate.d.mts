export type FullBenchmarkProjectDecision =
  | 'ordinary'
  | 'blocked'
  | 'full';

export function fullBenchmarkProjectDecision(input: {
  candidate: boolean;
  databaseUrl?: string | null;
  environment?: string | null;
  dispatchEnabled?: boolean | null;
  nativeDispatchEnabled?: boolean | null;
  trialId?: string | null;
}): FullBenchmarkProjectDecision;

export type FullBenchmarkBinding={trial_id:string;account_id:string;benchmark_contract_hash:string;baseline_sha:string;model:string};
export function assertFullBenchmarkRuntime(env:Record<string,string|undefined>):void;
export function loadFullBenchmarkBinding(db:unknown,projectId:string|null|undefined,env:Record<string,string|undefined>):Promise<FullBenchmarkBinding|null>;
