import { createAccountingFetchWithPolicy, type AccountingTransmissionPolicy } from './dispatch';
import { runWithStandaloneActivity } from './context';
import type { AccountingProvider } from './pricing';
export function createActivityAccountingFetch(provider:AccountingProvider,activity:string,policy:AccountingTransmissionPolicy={}):typeof fetch {
  const transport=createAccountingFetchWithPolicy(provider,policy);
  return (input,init)=>runWithStandaloneActivity(activity,()=>transport(input,init));
}
