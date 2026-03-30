export const DIRECTIVE_KINDS = ["style", "workflow", "business_context", "constraint", "preference"] as const;

export const DIRECTIVE_SCOPES = ["actor", "global"] as const;

export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number];
export type DirectiveScope = (typeof DIRECTIVE_SCOPES)[number];

export interface PersistentDirective {
  id: string;
  userId: string;
  actorId: string;
  directive: string;
  kind: DirectiveKind;
  scope: DirectiveScope;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
