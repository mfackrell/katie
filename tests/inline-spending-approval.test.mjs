import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const usage = readFileSync('components/standalone-usage.tsx', 'utf8');
const panel = readFileSync('components/chat-panel.tsx', 'utf8');

test('the chat shows owner spending decisions inline, including after a refresh', () => {
  assert.match(panel, /<StandaloneUsage inlinePendingOnly actorId=\{actorId\} chatId=\{chatId\} \/>/);
  assert.match(usage, /const inlinePendingContent = snapshotScope\.current ===/);
  assert.match(usage, /if \(inlinePendingOnly\) return inlinePendingContent/);
  assert.match(usage, /snapshot\?\.pending\.length/);
  assert.match(usage, /snapshot\.pending\.map\(attempt =>/);
  assert.match(usage, /void next\.refresh\(\)/, 'initial ledger read recovers existing paused approvals');
  assert.match(usage, /addEventListener\('standalone-accounting-updated',update\)/, 'chat pause refreshes the inline card');
  assert.match(panel, /window\.dispatchEvent\(new Event\("standalone-accounting-updated"\)\)/);
});

test('desktop and legacy chat share their existing usage reader with the inline approval portal', () => {
  const workspace = readFileSync('components/chat-workspace.tsx', 'utf8');
  const legacy = readFileSync('app/legacy/page.tsx', 'utf8');
  assert.match(usage, /createPortal\(inlinePendingContent, inlineTarget\)/);
  assert.match(usage, /if \(rail\) return <>\{inlinePortal\}<section/);
  assert.match(panel, /id="katie-inline-spending-approval"/);
  assert.match(panel, /spendingApprovalEnabled && !managedAgentId && !spendingApprovalHostedExternally && <StandaloneUsage inlinePendingOnly/);
  assert.match(panel, /spendingApprovalEnabled = false/, 'unscoped direct chat mounts must not launch owner accounting');
  assert.match(panel, /spendingApprovalEnabled && !managedAgentId && <div id="katie-inline-spending-approval"/);
  assert.match(workspace, /spendingApprovalEnabled=\{!actor\.managedAgentId && actor\.actorKind !== 'executive'\}/);
  assert.match(legacy, /spendingApprovalEnabled=\{Boolean\(activeActor && !activeActor\.managedAgentId && activeActor\.actorKind !== 'executive'\)\}/);
  assert.match(workspace, /spendingApprovalHostedExternally=\{railOpen && !actor\.managedAgentId/);
  assert.match(legacy, /spendingApprovalHostedExternally=\{Boolean\(activeActor/);
  assert.match(usage, /createRefreshFlight\(async signal =>/);
});

test('the owner chooses whether to approve the exact selected attempt without changing normal thresholds', () => {
  assert.match(usage, /Approve selected model once/);
  assert.match(usage, /Estimated reservation:/);
  assert.match(usage, /automatic per-call threshold:/);
  assert.match(usage, /not a guaranteed actual-cost ceiling/);
  assert.match(usage, /onClick=\{\(\) => void decide\(attempt, 'approve_once'\)\}/);
  assert.match(usage, /preparedHash: attempt\.preparedHash, pricingVersion: attempt\.pricingVersion, budgetRevision: attempt\.budgetRevision, reservedMicrousd: attempt\.reservedMicrousd/);
  assert.match(usage, /if \(action === 'approve_once'\) \{\s*await requestSavedResume\(\{ attemptId: result\.attemptId as string, requestId: result\.requestId as string \}\)/);
});

test('approved continuation uses the original saved request and does not select another model', () => {
  assert.match(usage, /window\.dispatchEvent\(new CustomEvent\('standalone-accounting-resume'/);
  assert.match(panel, /window\.addEventListener\("standalone-accounting-resume",listener\)/);
  assert.match(panel, /"x-request-id":detail\.requestId/);
  assert.match(panel, /standaloneResume:true/);
  assert.match(usage, /onClick=\{\(\) => void decide\(attempt, 'cancel'\)\}/);
  assert.match(usage, /onClick=\{\(\) => void decide\(attempt, 'reduce_cost'\)\}/);
});
