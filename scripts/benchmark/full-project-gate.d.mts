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
