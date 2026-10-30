import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modules } from './helpers/load-project-modules.mjs';

const { requiresKatieWorkspaceSession } = modules()('@/lib/standalone-accounting/session-routes');

test('automatic guest session protects data-backed Katie workspace, including deep links', () => {
  for(const path of ['/', '/agents', '/conversations', '/conversations/new',
    '/conversations/11111111-1111-4111-8111-111111111111',
    '/work','/work/current','/specialists','/specialists/123',
    '/settings','/settings/advanced','/search','/legacy']){
    assert.equal(requiresKatieWorkspaceSession(path),true,path);
  }
});

test('independent public pages do not require a session merely to render', () => {
  for(const path of ['/project-pilots/signal-sprint',
    '/presentation-acceptance-fixture', '/not-found',
    '/project-pilots/another-game']){
    assert.equal(requiresKatieWorkspaceSession(path),false,path);
  }
});

test('workspace session barrier remains mandatory before protected UI and API authorization is unchanged',()=>{
  const gate=readFileSync('components/chat-session-gate.tsx','utf8');
  const layout=readFileSync('app/layout.tsx','utf8');
  const middleware=readFileSync('middleware.ts','utf8');
  assert.match(layout,/<ChatSessionGate>\{children\}<\/ChatSessionGate>/);
  assert.match(gate,/if\(!requiresKatieWorkspaceSession\(pathname\)\)return/);
  assert.match(gate,/return <VerifiedWorkspaceSession>\{children\}<\/VerifiedWorkspaceSession>/);
  assert.match(gate,/function VerifiedWorkspaceSession/);
  assert.match(gate,/await fetch\('\/api\/session'/);
  assert.match(middleware,/\/auth\/v1\/user/);
  assert.match(middleware,/if\(!token/);
});

