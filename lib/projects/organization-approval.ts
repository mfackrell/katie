export type OrganizationApproval = {
  projectId: string;
  objectiveHash: string;
  objective: string;
  clarifications: string;
  repositoryId: string | null;
  repository: string | null;
  deadline: string;
  limits: { codingJobs: number; missions: number; modelTokens: number };
};

// Decimal USD input becomes integer microUSD without floating-point rounding.
export function projectBudgetMicrousd(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  return amount > 0 && amount <= 1_000_000_000 ? amount : null;
}
