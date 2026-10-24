// Per-arm admission ledger: charge actual provider usage while reserving the worst case
// BEFORE each model request. Uses serial admission per arm; never share ledgers.
export class BenchmarkBudget {
 constructor(capTokens) {
  if(!Number.isSafeInteger(capTokens)||capTokens<=0)throw Error('invalid benchmark cap');
  this.capTokens=capTokens; this.committed=0; this.reservations=new Map();
 }
 get reserved(){return [...this.reservations.values()].reduce((sum,v)=>sum+v,0)}
 get available(){return this.capTokens-this.committed-this.reserved}
 reserve(requestId,upperTokens){
  if(typeof requestId!=='string'||!requestId||this.reservations.has(requestId))throw Error('invalid or duplicate request');
  if(!Number.isSafeInteger(upperTokens)||upperTokens<=0||upperTokens>this.available)throw Error('BENCHMARK_BUDGET_EXHAUSTED');
  this.reservations.set(requestId,upperTokens);
 }
 finish(requestId,{inputTokens,outputTokens}){
  const reserved=this.reservations.get(requestId);
  if(reserved===undefined)throw Error('unknown reservation');
  if(!Number.isSafeInteger(inputTokens)||inputTokens<0||!Number.isSafeInteger(outputTokens)||outputTokens<0)throw Error('unverified provider usage');
  const actual=inputTokens+outputTokens;
  if(!Number.isSafeInteger(actual)||actual>reserved)throw Error('PROVIDER_CAP_VIOLATION');
  this.reservations.delete(requestId); this.committed+=actual;
  return {actual,remaining:this.available};
 }
 // On ambiguous provider errors, retain reservation until reconciled; never refund blindly.
 snapshot(){return {capTokens:this.capTokens,committedTokens:this.committed,reservedTokens:this.reserved,availableTokens:this.available}}
}
