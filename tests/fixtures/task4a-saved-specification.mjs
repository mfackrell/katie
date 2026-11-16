export const oldPath='/project-pilots/task4a-preview-probe/';
export const newPath='app/project-pilots/task4a-preview-probe/';
export function savedTask4aPlan(){
 const initial={name:'Initial state and exactly one button',steps:[
  {action:'goto',path:oldPath},
  {action:'expectVisible',selector:'#task4a-app'},
  {action:'expectText',selector:'#task4a-state',value:'Initial state'},
  {action:'expectVisible',selector:'button'},
  {action:'expectText',selector:'button',value:'Change state'}
 ]};
 const transition={name:'The sole button changes state',steps:[
  {action:'goto',path:oldPath},{action:'click',selector:'button'},
  {action:'expectText',selector:'#task4a-state',value:'Changed state'},
  {action:'click',selector:'button'},
  {action:'expectText',selector:'#task4a-state',value:'Changed state'}
 ]};
 const reset={name:'Navigation resets state',steps:[
  {action:'goto',path:oldPath},{action:'click',selector:'button'},
  {action:'expectText',selector:'#task4a-state',value:'Changed state'},
  {action:'goto',path:oldPath},
  {action:'expectText',selector:'#task4a-state',value:'Initial state'}
 ]};
 const contract={path:oldPath,scenarios:[initial,transition,reset]};
 return {
  name:'Task 4A Preview Probe',
  summary:'One disposable browser application under the existing Next.js App Router, no production publication.',
  requirements:['One minimal browser application','Exactly one button','Visible state change','No production publication','Existing infrastructure only'],
  allowedPaths:[oldPath],
  milestones:[{title:'Build disposable probe',instruction:'Implement the original one-button state-change probe without dependencies, production publication or additional scope.',contract}],
  finalContract:JSON.parse(JSON.stringify(contract))
 };
}
export function savedTask4aFinalReview(){
 return {verdict:'pass',checks:Array.from({length:6},(_,n)=>({id:'criterion:'+n,passed:true,evidence:'Source candidate meets the original Task 4A outcome.'})),
  summary:'PASS for original reviewed candidate, before the deterministic source-path correction'};
}
