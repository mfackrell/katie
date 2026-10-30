/** The login-free bootstrap applies to Katie's data-backed workspace, not
 * independent public pages (demos, game pilots or isolated render fixtures).
 * API authorization remains enforced on every protected endpoint. */
const WORKSPACE_ROOTS = [
  '/agents', '/conversations', '/legacy', '/search',
  '/settings', '/specialists', '/work',
] as const;

export function requiresKatieWorkspaceSession(pathname: string): boolean {
  return pathname === '/' || WORKSPACE_ROOTS.some(
    root => pathname === root || pathname.startsWith(root + '/')
  );
}

