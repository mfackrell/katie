export type RoutingMode = 'best_answer' | 'best_value';
export interface RoutingPreferences {
  global: RoutingMode;
  conversation: RoutingMode | null;
  effective: RoutingMode;
}
export function isRoutingMode(value: unknown): value is RoutingMode {
  return value === 'best_answer' || value === 'best_value';
}
export function effectiveRoutingMode(global: RoutingMode | null, conversation: RoutingMode | null): RoutingMode {
  return conversation ?? global ?? 'best_value';
}
