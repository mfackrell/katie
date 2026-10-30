/** One transport at a time. Periodic ticks drop; changes coalesce once. */
export function createRefreshFlight(run:(signal:AbortSignal)=>Promise<void>){
 let current:Promise<void>|undefined, queued=false, disposed=false;
 const controller=new AbortController();
 const refresh=(changed=true):Promise<void>=>{
  if(disposed)return Promise.resolve();
  if(current){if(changed)queued=true;return current;}
  current=(async()=>{try{do{queued=false;await run(controller.signal);}while(queued&&!disposed);}finally{current=undefined;}})();
  return current;
 };
 return {refresh,dispose(){disposed=true;queued=false;controller.abort();}};
}
