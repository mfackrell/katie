import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const routeSource = readFileSync('app/api/chat/route.ts', 'utf8');
const routeAst = ts.createSourceFile('route.ts', routeSource, ts.ScriptTarget.Latest, true);
const quietConsole = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name, () => {}]));
const nativeRequire = createRequire(import.meta.url);
const plain = value => JSON.parse(JSON.stringify(value));
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function findNodes(predicate, root = routeAst) {
  const matches = [];
  const visit = node => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function unique(nodes, description) {
  assert.equal(nodes.length, 1, `Production route must have one ${description}`);
  return nodes[0];
}

function ancestor(node, predicate) {
  for (let current = node; current; current = current.parent) {
    if (predicate(current)) return current;
  }
  throw new Error('Expected route ancestor was not found');
}

const calls = name => findNodes(node => ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) && node.expression.text === name);
const call = name => unique(calls(name), `${name} call`);
const declaration = name => unique(findNodes(node => ts.isVariableDeclaration(node) &&
  ts.isIdentifier(node.name) && node.name.text === name), `${name} declaration`);
const statement = node => ancestor(node, current => current.parent && ts.isBlock(current.parent));
const code = node => node.getText(routeAst);
function blockBetween(first, last) {
  assert.equal(first.parent, last.parent, 'Route statements must share their production block');
  assert.ok(first.pos <= last.pos, 'Route statement order changed');
  return routeSource.slice(first.getStart(routeAst), last.end);
}

// Execute production statements selected by their AST, not copied gate logic.
const continuitySelection = unique(calls('applyUserToTaskProgress').filter(node =>
  ts.isBinaryExpression(node.parent)), 'post-classification task selection');
const selectionBlock = blockBetween(statement(continuitySelection), statement(declaration('requiredReviewForRequest')));
const collaborationGate = code(statement(declaration('collaborationEnabledForRequest')));
const generationParams = code(unique(findNodes(node => ts.isFunctionDeclaration(node) &&
  node.name?.text === 'buildGenerationParams'), 'buildGenerationParams function'));
const createParams = code(statement(declaration('createParams')));
const enqueueDelta = code(statement(declaration('enqueueDelta')));
const runAttempt = code(unique(findNodes(node => ts.isPropertyAssignment(node) &&
  node.name.getText(routeAst) === 'runAttempt' && ts.isArrowFunction(node.initializer)), 'generation attempt callback').initializer);
const reviewBlock = code(ancestor(call('runRequiredDraftReview'), ts.isIfStatement));
const escalationGuard = code(statement(declaration('escalatedConversation')));
const completionBlock = blockBetween(statement(call('applyAssistantToTaskProgress')),
  ancestor(call('resolvePendingReviewClarification'), ts.isIfStatement));
const contentCall = unique(findNodes(node => ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) && node.expression.text === 'emitChunk' &&
  node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0]) &&
  node.arguments[0].properties.some(property => ts.isPropertyAssignment(property) &&
    property.name.getText(routeAst) === 'type' && ts.isStringLiteral(property.initializer) &&
    property.initializer.text === 'content') && node.pos > call('runRequiredDraftReview').pos), 'final content publication');

const ACTOR_ID = 'actor-fixture';
const CHAT_ID = 'chat-fixture';
const POSTING_ID = 'd915cf3e-9cd3-4199-a502-2d5ed8a5000d';
const QUESTION_ID = '44a6f320-6817-49f6-b040-83bbec75e1eb';
const REPLY_ID = 'ab735682-c041-4adc-aee0-188d66d01c83';
const OLD_REQUEST_ID = 'ca9c59aa-de01-46ec-88db-a77d6b0cc3b4';
const OLD_TASK = 'Please share 3 to 5 examples of your relevant experience.';
// The beginning of the actual pasted posting, sufficient to identify the project.
const DISTRIBUTION_POSTING = 'FP&A/P&L Advisor for PE-Backed Distribution Company (U.S. only; Hybrid)\n' +
  ' Southern California  11/02/2026 - 05/02/2027\n' +
  'Our client, an approximately $100M food distribution company, is seeking an FP&A/P&L Advisor to partner closely with a newly appointed President and support a broader performance improvement effort.';
const CURRENT_QUESTION = "**One question:** Do you have any distribution, wholesale, or sponsor-reporting experience that isn't in your record? If not, I'll position the application on the adjacent evidence above.";
const SHORT_REPLY = 'i do not have specific distribution, wholesale experience, i dont know what sporsor reporting is.';
const EXPLANATION = 'Sponsor reporting means financial updates prepared for a private-equity owner, such as monthly results and forecasts. Your lack of distribution or wholesale experience is clear; unfamiliarity with that term does not establish whether you have done the underlying work.';

function fixture() {
  const oldQuestion = 'Which four examples should I include in the earlier application?';
  const rows = [{
    request_id: OLD_REQUEST_ID, actor_id: ACTOR_ID, chat_id: CHAT_ID,
    assistant_message_id: 'old-question', created_at: '2026-10-13T19:53:26.164+00:00',
    updated_at: '2026-10-13T19:53:26.164+00:00',
    review_audit: { status: 'needs_user_input', pendingClarification: {
      question: oldQuestion, reason: 'An earlier task needed information.',
      deliverable: OLD_TASK, candidate: 'OLD FOUR-EXAMPLE DRAFT', requirementIds: ['examples'],
      sourceTurns: [{ id: 'latest-user', text: OLD_TASK }], createdAt: '2026-10-13T19:53:26.164+00:00',
    } },
  }];
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://supabase.example.test');
    assert.equal(url.pathname, '/rest/v1/chat_requests');
    assert.equal(url.searchParams.get('actor_id'), `eq.${ACTOR_ID}`);
    assert.equal(url.searchParams.get('chat_id'), `eq.${CHAT_ID}`);
    const matches = rows.filter(row => [...url.searchParams].every(([field, value]) =>
      ['select', 'order', 'limit'].includes(field) || value === `eq.${String(row[field])}`));
    requests.push({ method: init.method, url });
    if (init.method === 'PATCH') {
      const patch = JSON.parse(String(init.body));
      for (const row of matches) Object.assign(row, patch);
      return new Response(null, { status: 204 });
    }
    assert.equal(init.method, 'GET');
    matches.sort((left, right) => right.created_at.localeCompare(left.created_at));
    if (init.headers?.Accept === 'application/vnd.pgrst.object+json') {
      return matches.length ? Response.json(matches[0]) : new Response(null, { status: 406 });
    }
    return Response.json(matches.slice(0, Number(url.searchParams.get('limit') ?? matches.length)));
  };
  const modules = new Map();
  const globals = { URL, Response, Date, Map, Set, console: quietConsole, fetch,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.example.test', SUPABASE_SERVICE_ROLE_KEY: 'test-only-no-network' } } };
  const load = path => {
    path = resolve(path.endsWith('.ts') ? path : path + '.ts');
    if (modules.has(path)) return modules.get(path);
    const exports = {};
    modules.set(path, exports);
    vm.runInNewContext(compile(readFileSync(path, 'utf8')), {
      ...globals, exports,
      require: name => name.startsWith('node:') || name === 'zod' ? nativeRequire(name)
        : load(name.startsWith('@/') ? name.slice(2) : resolve(dirname(path), name)),
    }, { filename: path });
    return exports;
  };
  const helpers = Object.assign({}, ...[
    'lib/chat/task-progress', 'lib/chat/response-policy', 'lib/chat/review-continuity',
    'lib/chat/review-sources', 'lib/chat/video-evidence', 'lib/collaboration/review-completion',
    'lib/collaboration/activation', 'lib/collaboration/review-mode', 'lib/data/supabase/admin', 'lib/agents/policy',
  ].map(load));
  const history = [
    { id: 'old-task', role: 'user', content: OLD_TASK },
    { id: 'old-question', role: 'assistant', content: oldQuestion },
  ];
  return { rows, requests, helpers, history, globals };
}

async function select(f, { message, messageId, priorTaskProgress, history, projectRelation = 'same_project', responsePurpose = 'conversation', reviewMode = 'always' }) {
  return vm.runInNewContext(compile(`(async () => {
    let taskProgress = priorTaskProgress;
    ${selectionBlock}
    ${collaborationGate}
    return { taskProgress, reviewTaskProgress, pendingReviewClarification, verifyingSavedDraft,
      savedDraftOriginalTask, taskProgressContext, resumptionContext, responsePolicy,
      requiredReviewForRequest, collaborationEnabledForRequest };
  })()`), {
    ...f.globals, ...f.helpers, actorId: ACTOR_ID, chatId: CHAT_ID, requestId: 'current-request',
    message, taskProgressUserMessageId: messageId, priorTaskProgress, history,
    projectRelationHint: projectRelation, responsePurposeHint: responsePurpose,
    resolvedRequestIntent: 'general-text', resolvedRoutingIntentForReroute: { complexity: 'low' },
    reviewMode, attachments: [], images: [], storedWebsite: { fresh: false },
    timelineActive: false, mediaMemory: null, overrideProvider: null, overrideModel: null, hasVideoInput: false,
  });
}

async function replayPosting(f) {
  const before = f.helpers.rebuildTaskProgress(f.history);
  const posting = await select(f, { message: DISTRIBUTION_POSTING, messageId: POSTING_ID,
    priorTaskProgress: before, history: f.history, projectRelation: 'new_project', responsePurpose: 'deliverable' });
  assert.equal(posting.pendingReviewClarification, null);
  assert.equal(posting.resumptionContext, '');
  assert.equal(posting.taskProgress.projectContext.userMessageId, POSTING_ID);
  assert.equal(posting.taskProgress.objective.userMessageId, POSTING_ID);
  const progress = f.helpers.applyAssistantToTaskProgress(posting.taskProgress, { messageId: QUESTION_ID, text: CURRENT_QUESTION });
  const history = [...f.history, { id: POSTING_ID, role: 'user', content: DISTRIBUTION_POSTING },
    { id: QUESTION_ID, role: 'assistant', content: CURRENT_QUESTION }];
  return { progress, history };
}

function addCurrentPending(f, progress, questionMessageId, question, candidate = 'CURRENT SAVED DRAFT') {
  const pending = f.helpers.bindPendingReviewClarification({
    question, reason: 'Current task needs information.', deliverable: DISTRIBUTION_POSTING,
    candidate, requirementIds: ['experience'],
    sourceTurns: [{ id: 'latest-user', text: DISTRIBUTION_POSTING }],
    createdAt: '2026-10-16T19:31:41.000+00:00',
  }, progress, questionMessageId);
  const row = { request_id: 'current-pending', actor_id: ACTOR_ID, chat_id: CHAT_ID,
    assistant_message_id: questionMessageId, created_at: '2026-10-16T19:31:41.000+00:00',
    updated_at: '2026-10-16T19:31:41.000+00:00', review_audit: { status: 'needs_user_input', pendingClarification: pending } };
  f.rows.push(row);
  return row;
}

async function runPipeline(f, selection, { message = SHORT_REPLY, history, output = EXPLANATION, resultExtras = {}, generationMessage = message, reviewMode = 'always' }) {
  const counts = { provider: 0, collaboration: 0, capability: 0, review: 0 };
  const chunks = [];
  const generationInputs = [];
  const reviews = [];
  const providerResult = () => ({ text: output, provider: 'anthropic', model: 'fixture-haiku', ...resultExtras });
  const provider = { name: 'anthropic',
    async generate(params) { counts.provider++; generationInputs.push(params); return providerResult(); },
    async generateStream(params, hooks) {
      counts.provider++; generationInputs.push(params);
      await hooks.onTextDelta(output);
      return providerResult();
    },
  };
  const state = await vm.runInNewContext(compile(`(async () => {
    ${generationParams}
    ${createParams}
    ${enqueueDelta}
    const execute = ${runAttempt};
    let result = await execute({ provider, modelId }, 0);
    ${escalationGuard}
    ${reviewBlock}
    ${code(statement(declaration('imageAssets')))}
    ${code(statement(contentCall))}
    const assistantText = result.text || streamedText;
    const assistantMessageId = taskProgressAssistantMessageId;
    ${completionBlock}
    return { result, taskProgress, escalatedConversation, reviewCompleted };
  })()`), {
    ...f.globals, ...f.helpers, ...selection,
    message, messageForGeneration: generationMessage, actorId: ACTOR_ID, chatId: CHAT_ID, requestId: 'current-request',
    taskProgressAssistantMessageId: 'current-answer', provider, providers: [provider], modelId: 'fixture-haiku',
    name: 'Katie', personaForGeneration: 'Katie persona', summary: '', historyForProvider: history,
    attachments: [], images: [], storedWebsite: { fresh: false, context: '', previousWebsiteEvidence: undefined },
    mediaMemory: null, timelineContext: '', hasVideoInput: false, creativeNarrativeRequest: false,
    resolvedRequestIntent: 'general-text', resolvedRoutingIntentForReroute: { complexity: 'low' },
    intentAuthority: 'llm', reviewMode, pendingVideoAssistantMessageId: null, reviewSourceParams: undefined,
    streamedText: '', reviewCompleted: false, reviewHasPendingClarification: false,
    collaborationResumeState: undefined, collaborationConfig: {}, collaborationDeadlineMs: Date.now() + 300_000,
    executionDeadlineMs: Date.now() + 600_000, selectionExplainer: null, savedWebsiteEvidence: undefined,
    buildKatieRuntimeContext: () => 'KATIE_RUNTIME_CONTEXT: fixture',
    replaceKatieRuntimeContext: (persona, runtime) => persona + '\n' + runtime,
    inferModelTier: () => 'light', shouldSuppressCalculationScaffolding: () => false,
    emitChunk: chunk => chunks.push(plain(chunk)), saveProviderSystemAudit: async () => {},
    saveTaskProgress: async () => true,
    runAdaptiveCollaboration: async () => {
      counts.collaboration++;
      return { result: providerResult(), streamedText: output, metadata: { used: true } };
    },
    runOnDemandCapabilityEscalation: async () => {
      counts.capability++;
      return { result: providerResult(), streamedText: output, metadata: null };
    },
    runRequiredDraftReview: async input => {
      counts.review++; reviews.push(input);
      return { result: { ...input.draft, text: 'REVIEWED: ' + input.draft.text }, audit: { status: 'approved' } };
    },
  });
  return { counts, chunks, generationInputs, reviews, ...state };
}

test('actual route rejects the old October pending task and answers the 97-character clarification directly', async () => {
  assert.equal(SHORT_REPLY.length, 97);
  const f = fixture();
  const { progress, history } = await replayPosting(f);
  const current = addCurrentPending(f, progress, QUESTION_ID, CURRENT_QUESTION);
  const selected = await select(f, { message: SHORT_REPLY, messageId: REPLY_ID, priorTaskProgress: progress, history });
  assert.equal(selected.pendingReviewClarification, null);
  assert.equal(selected.resumptionContext, '');
  assert.equal(selected.responsePolicy.purpose, 'conversation');
  assert.equal(selected.requiredReviewForRequest, false);
  assert.equal(selected.collaborationEnabledForRequest, false);
  assert.ok(selected.taskProgress.pending.some(question => question.assistantMessageId === QUESTION_ID));

  const result = await runPipeline(f, selected, { history });
  assert.deepEqual(result.counts, { provider: 1, collaboration: 0, capability: 0, review: 0 });
  assert.equal(result.generationInputs[0].user, SHORT_REPLY);
  assert.ok(!result.generationInputs[0].persona.includes('OLD FOUR-EXAMPLE DRAFT'));
  assert.ok(!result.generationInputs[0].persona.includes('KATIE_RESUME_PENDING_COMPLETION'));
  assert.ok(result.taskProgress.pending.some(question => question.assistantMessageId === QUESTION_ID));
  assert.ok(result.taskProgress.answered.some(answer => answer.userMessageId === REPLY_ID &&
    answer.partial === true && answer.answer === 'i do not have specific distribution, wholesale experience'));
  assert.equal(current.review_audit.pendingClarification.resolvedAt, undefined);
  assert.equal(f.rows[0].review_audit.pendingClarification.resolvedAt, undefined);
  assert.equal(f.requests.filter(request => request.method === 'PATCH').length, 0);
  assert.equal(result.chunks.find(chunk => chunk.type === 'content').text, EXPLANATION);
});

test('actual route reviews unexpected substantive output before publication and keeps the latest source literal', async () => {
  const f = fixture();
  const { progress, history } = await replayPosting(f);
  const selected = await select(f, { message: SHORT_REPLY, messageId: REPLY_ID, priorTaskProgress: progress, history });
  const draft = 'Here is your revised application: I bring extensive financial transformation experience.';
  const result = await runPipeline(f, selected, { history, output: draft,
    generationMessage: SHORT_REPLY + '\n\nGENERATION-ONLY INTERNAL CONTEXT' });
  assert.equal(result.escalatedConversation, true);
  assert.deepEqual(result.counts, { provider: 1, collaboration: 0, capability: 0, review: 1 });
  assert.equal(result.chunks.filter(chunk => chunk.type === 'delta').length, 0);
  assert.equal(result.chunks.find(chunk => chunk.type === 'content').text, 'REVIEWED: ' + draft);
  const review = result.reviews[0];
  assert.deepEqual(plain(review.sourceTurns.at(-1)), { id: 'latest-user', text: SHORT_REPLY });
  assert.ok(review.sourceTurns.some(turn => turn.text === DISTRIBUTION_POSTING));
  assert.ok(review.sourceTurns.every(turn => !turn.text.includes('GENERATION-ONLY INTERNAL CONTEXT')));
  assert.equal(review.assessmentParams.user, SHORT_REPLY);
});

test('actual route retains mandatory review for a terse drafting request despite a conversation hint', async () => {
  const f = fixture();
  const { progress, history } = await replayPosting(f);
  const message = 'Draft the application.';
  const selected = await select(f, { message, messageId: 'draft-request', priorTaskProgress: progress, history });
  assert.equal(selected.responsePolicy.purpose, 'deliverable');
  assert.equal(selected.requiredReviewForRequest, true);
  assert.equal(selected.collaborationEnabledForRequest, true);
  const result = await runPipeline(f, selected, { message, history, output: 'A short candidate response.' });
  assert.equal(result.counts.collaboration, 1);
  assert.equal(result.counts.review, 1);
  assert.equal(result.chunks.find(chunk => chunk.type === 'content').text, 'REVIEWED: A short candidate response.');
  assert.deepEqual(plain(result.reviews[0].sourceTurns.at(-1)), { id: 'latest-user', text: message });
});

test('actual output safeguard reviews reported helper work even when its final text is brief', async () => {
  const f = fixture();
  const { progress, history } = await replayPosting(f);
  const selected = await select(f, { message: SHORT_REPLY, messageId: REPLY_ID, priorTaskProgress: progress, history });
  const result = await runPipeline(f, selected, { history, output: 'Done.',
    resultExtras: { collaboration: { used: true, delegationCount: 1 } } });
  assert.equal(result.escalatedConversation, true);
  assert.equal(result.counts.review, 1);
  assert.equal(result.chunks.find(chunk => chunk.type === 'content').text, 'REVIEWED: Done.');
});

test('actual saved-verification retry reviews the matched candidate without generating a replacement', async () => {
  const f = fixture();
  const replay = await replayPosting(f);
  const question = 'Would you like me to retry verification with the saved draft?';
  const progress = f.helpers.applyAssistantToTaskProgress(replay.progress, { messageId: 'retry-question', text: question });
  const history = [...replay.history, { id: 'retry-question', role: 'assistant', content: question }];
  const current = addCurrentPending(f, progress, 'retry-question', question, 'EXACT SAVED CANDIDATE');
  const selected = await select(f, { message: 'yes', messageId: 'retry-answer', priorTaskProgress: progress, history });
  assert.equal(selected.pendingReviewClarification?.requestId, current.request_id);
  assert.equal(selected.verifyingSavedDraft, true);
  assert.equal(selected.requiredReviewForRequest, true);
  assert.equal(selected.collaborationEnabledForRequest, false);
  const result = await runPipeline(f, selected, { message: 'yes', history });
  assert.deepEqual(result.counts, { provider: 0, collaboration: 0, capability: 0, review: 1 });
  assert.equal(result.reviews[0].draft.text, 'EXACT SAVED CANDIDATE');
  assert.deepEqual(plain(result.reviews[0].sourceTurns.at(-1)), { id: 'latest-user', text: 'yes' });
  assert.ok(!result.reviews[0].assessmentParams.user.includes('EXACT SAVED CANDIDATE'));
  assert.equal(current.review_audit.pendingClarification.resumedByRequestId, 'current-request');
  assert.equal(f.rows[0].review_audit.pendingClarification.resolvedAt, undefined);
});
