export default async function runPreviewAcceptance(target) {
 const receipt={schemaVersion:1,startedAt:new Date().toISOString(),sourceCommit:'64339aaf987b03cddd54d3d21117769f0b4edcc4',deploymentId:'dpl_ADinzR9FpqvSEYKTmSZZAXgRyiGu',url:await target.url(),executor:'cua_repl cloud Chromium with Playwright locators',checkpoints:[],passed:false};
 const url='https://katie-hss4o6f8j-mark-fackrells-projects.vercel.app/project-pilots/beacon-relay';
 if(receipt.url!==url)throw Error('Unexpected deployment URL');
 let expected={positions:{Red:0,Blue:15},scores:{Red:0,Blue:0},activePlayer:'Red',phase:'MOVE',turn:1,winner:null};
 async function step(action,patch={}){
  if(action==='reload')await target.reload();else await target.playwright.locator(action).click();
  expected={...expected,...patch};
  const fields={'#red-position':expected.positions.Red,'#blue-position':expected.positions.Blue,'#red-score':expected.scores.Red,'#blue-score':expected.scores.Blue,'#active-player':expected.activePlayer,'#phase':expected.phase,'#turn-number':expected.turn,'#winner':expected.winner??'None'};
  const checkpoint={action,url:await target.url(),assertions:[]};receipt.checkpoints.push(checkpoint);
  if(checkpoint.url!==url)throw Error('Navigation escaped deployment');
  for(const [selector,value] of Object.entries(fields)){
   const actual=(await target.playwright.locator(selector).innerText()).trim();
   const assertion={selector,expected:String(value),actual,passed:actual===String(value)};
   checkpoint.assertions.push(assertion);if(!assertion.passed)throw Error(JSON.stringify(assertion));
  }
 }
 try{
 await step('#reset');await step('#end-turn');for(const c of [0,5,15,3])await step('#cell-'+c);
 await step('#cell-1',{positions:{Red:1,Blue:15},phase:'RESOLVE'});await step('#cell-2');await step('#end-turn',{activePlayer:'Blue',turn:2,phase:'MOVE'});
 await step('#cell-14',{positions:{Red:1,Blue:14},phase:'RESOLVE'});await step('#end-turn',{activePlayer:'Red',turn:3,phase:'MOVE'});
 await step('#cell-5',{positions:{Red:5,Blue:14},phase:'RESOLVE'});await step('reload');await step('#cell-6');
 await step('#end-turn',{scores:{Red:1,Blue:0},activePlayer:'Blue',turn:4,phase:'MOVE'});await step('#end-turn');
 await step('#cell-10',{positions:{Red:5,Blue:10},phase:'RESOLVE'});await step('#end-turn',{scores:{Red:1,Blue:1},activePlayer:'Red',turn:5,phase:'MOVE'});
 await step('#cell-6',{positions:{Red:6,Blue:10},phase:'RESOLVE'});await step('#end-turn',{activePlayer:'Blue',turn:6,phase:'MOVE'});
 await step('#cell-11',{positions:{Red:6,Blue:11},phase:'RESOLVE'});await step('#end-turn',{activePlayer:'Red',turn:7,phase:'MOVE'});
 await step('#cell-5',{positions:{Red:5,Blue:11},phase:'RESOLVE'});await step('#end-turn',{scores:{Red:2,Blue:1},phase:'GAME_OVER',winner:'Red'});
 await step('#end-turn');await step('#cell-4');await step('reload');
 await step('#reset',{positions:{Red:0,Blue:15},scores:{Red:0,Blue:0},activePlayer:'Red',phase:'MOVE',turn:1,winner:null});await step('reload');receipt.passed=true;
 }catch(error){receipt.error=String(error);}
 receipt.completedAt=new Date().toISOString();receipt.assertionCount=receipt.checkpoints.reduce((n,c)=>n+c.assertions.length,0);return receipt;
}
