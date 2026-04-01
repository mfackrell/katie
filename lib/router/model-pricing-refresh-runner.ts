import { refreshModelPricing } from "@/lib/router/model-pricing-refresh";

type RefreshExecutor = typeof refreshModelPricing;

let refreshExecutor: RefreshExecutor = refreshModelPricing;

export function __setRefreshExecutorForTests(executor: RefreshExecutor) {
  refreshExecutor = executor;
}

export async function runModelPricingRefresh() {
  return refreshExecutor();
}
