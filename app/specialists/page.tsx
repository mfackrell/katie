import { Suspense } from "react";
import { SpecialistsScreen } from "@/components/workspace-screens";
export default function Page() {
  return (
    <Suspense fallback={<p className="p-8">Loading…</p>}>
      <SpecialistsScreen />
    </Suspense>
  );
}
