import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  applyAssistantToTaskProgress,applyUserToTaskProgress,emptyTaskProgress,
  formatTaskProgress,rebuildTaskProgress,
} from '../lib/chat/task-progress';
import {
  isCompanionActorIdentity,isExplicitCompanionProjectSource,
  scopeCompanionTaskProgress,shouldTrackCompanionProject,
  recordCompanionConversationTurn,finishCompanionConversationTurn,
} from '../lib/chat/companion-task-boundary';

test('only an explicit companion actor persona enters companion dialogue mode',()=>{
  assert.equal(isCompanionActorIdentity({name:'Adult Katie',systemPrompt:'A conversational actor'}),true);
  assert.equal(isCompanionActorIdentity({name:'Different actor',systemPrompt:'KATIE — Adult Companion System Prompt\nCore identity'}),true);
  assert.equal(isCompanionActorIdentity({name:'Katie',systemPrompt:'Talk about Adult Katie as a separate actor.'}),false);
  assert.equal(isCompanionActorIdentity({name:'Katie',systemPrompt:'Normal finance and business assistant.'}),false);
});

test('original companion regression: old casual greeting, older objective and unfinished question cannot become current image instructions',()=>{
  const history=[
    {id:'u1',role:'user' as const,content:'Hi Katie'},
    {id:'a1',role:'assistant' as const,content:'What is on your mind?'},
    {id:'u2',role:'user' as const,content:"Good. What's up?"},
    {id:'a2',role:'assistant' as const,content:'I am listening.'},
    {id:'u3',role:'user' as const,content:'Describe my cock'},
    {id:'a3',role:'assistant' as const,content:'Do you want me to see it?'},
    {id:'u4',role:'user' as const,content:'You want to see it?'},
    {id:'a4',role:'assistant' as const,content:'Are you going to show me?'},
  ];
  const immutableHistory=structuredClone(history);
  const legacy=rebuildTaskProgress(history);
  assert.equal(legacy.projectContext?.text,"Good. What's up?",'reproduce the synthetic project from a conversational turn');
  assert.equal(legacy.objective?.text,'Describe my cock','reproduce the old current objective');
  assert.ok(legacy.pending.length>0,'reproduce the old open assistant question');

  const scoped=scopeCompanionTaskProgress(legacy);
  assert.equal(scoped.projectContext,null);
  assert.equal(scoped.objective,null);
  assert.deepEqual(scoped.pending,[]);
  assert.deepEqual(scoped.projects??[],[]);
  assert.equal(shouldTrackCompanionProject({message:'[image]',previous:scoped}),false);

  const current=recordCompanionConversationTurn(scoped,{messageId:'image-only',text:'[image]'});
  const finished=finishCompanionConversationTurn(current,'a-image');
  assert.equal(finished.lastUserMessageId,'image-only');
  assert.equal(finished.lastAssistantMessageId,'a-image');
  assert.equal(finished.lastUserSource?.text,'[image]');
  assert.equal(finished.objective,null);
  assert.equal(finished.projectContext,null);
  assert.deepEqual(finished.pending,[]);
  assert.deepEqual(finished.answered,[]);
  assert.equal(finished.projects,undefined);
  assert.deepEqual(history,immutableHistory,'the source history must remain unmodified');
  assert.equal(shouldTrackCompanionProject({message:'But you asked to see it',previous:finished}),false);
});

test('ordinary companion image-only conversation never tracks dangling assistant questions on later turns',()=>{
  let legacy=applyUserToTaskProgress(emptyTaskProgress(),{messageId:'old',text:'Describe this photograph'});
  legacy=applyAssistantToTaskProgress(legacy,{messageId:'old-answer',text:'Would you like to tell me more about it?'});
  assert.ok(legacy.pending.length>0);
  const first=recordCompanionConversationTurn(scopeCompanionTaskProgress(legacy),{messageId:'image',text:'[image]'});
  const delivered=finishCompanionConversationTurn(first,'image-reply');
  const second=recordCompanionConversationTurn(delivered,{messageId:'followup',text:'What did you think?'});
  assert.equal(shouldTrackCompanionProject({message:'What did you think?',previous:second}),false);
  assert.equal(second.objective,null);
  assert.deepEqual(second.pending,[]);
  assert.equal(second.lastUserMessageId,'followup');
  assert.equal(second.lastAssistantMessageId,'image-reply');
});

test('verified explicit project remains available without promoting casual companion dialogue',()=>{
  assert.equal(isExplicitCompanionProjectSource('New project: build a reporting dashboard'),true);
  assert.equal(isExplicitCompanionProjectSource('Build a dashboard for finance operations'),true);
  assert.equal(isExplicitCompanionProjectSource("Good. What's up?"),false);
  assert.equal(isExplicitCompanionProjectSource('Describe this photo'),false);
  const archived=applyUserToTaskProgress(emptyTaskProgress(),{messageId:'real-project',text:'New project: build a reporting dashboard'});
  const polluted=applyUserToTaskProgress(archived,{messageId:'casual',text:'Describe this photo'});
  const scoped=scopeCompanionTaskProgress(polluted);
  assert.ok(scoped.projects?.some(p=>p.projectContext.userMessageId==='real-project'));
  const message='Resume the saved project: the reporting dashboard';
  assert.equal(shouldTrackCompanionProject({message,previous:scoped,explicitProjectIntent:true}),true);
  const unrelated=recordCompanionConversationTurn(scoped,{messageId:'unrelated',text:'[image]'});
  assert.equal(unrelated.objective,null);
  assert.equal(unrelated.projectContext,null);
  assert.equal(unrelated.projects?.length,1,'real projects remain discoverable on explicit resume');

  let active=applyUserToTaskProgress(emptyTaskProgress(),{messageId:'report',text:'New project: prepare reporting package'});
  active=applyAssistantToTaskProgress(active,{messageId:'question',text:'What reporting month should I use?'});
  assert.equal(shouldTrackCompanionProject({message:'September 2026',previous:active}),true);
  assert.match(formatTaskProgress(active),/New project: prepare reporting package/);
});

test('chat route gates task injection and task writes without changing conversation history or Qwen evidence',()=>{
  const route=readFileSync('app/api/chat/route.ts','utf8');
  assert.match(route,/const priorTaskProgress = companionActor \? scopeCompanionTaskProgress\(loadedTaskProgress\) : loadedTaskProgress/);
  assert.match(route,/const companionOnlyTurn = companionActor && !shouldTrackCompanionProject/);
  assert.match(route,/companionOnlyTurn \? recordCompanionConversationTurn/);
  assert.match(route,/const taskProgressContext = companionOnlyTurn \? '' : formatTaskProgress\(reviewTaskProgress\)/);
  assert.match(route,/companionOnlyTurn\s*\? finishCompanionConversationTurn/);
  assert.match(route,/history: historyForProvider/);
  assert.match(route,/const descriptions=await observeStandaloneStillImages/);
  assert.ok(route.indexOf('scopeCompanionTaskProgress(loadedTaskProgress)')<route.indexOf('const contextProjects = taskProjectCatalog(priorTaskProgress)'));
});
