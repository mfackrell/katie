import { createAccountingFetch } from './dispatch';
import { runWithStandaloneActivity } from './context';
import type { AccountingProvider } from './pricing';
export function createActivityAccountingFetch(provider:AccountingProvider,activity:string):typeof fetch {
  const transport=createAccountingFetch(provider);
  return (input,init)=>runWithStandaloneActivity(activity,()=>transport(input,init));
}
