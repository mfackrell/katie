import { Suspense } from "react";
import { GlobalSearchScreen } from "@/components/global-search";
export default function Page() {
  return (
    <Suspense fallback={<p className="p-8">Loading search…</p>}>
      <GlobalSearchScreen />
    </Suspense>
  );
}
