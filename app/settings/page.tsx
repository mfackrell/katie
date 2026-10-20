import { Suspense } from "react";
import { SettingsScreen } from "@/components/workspace-screens";
export default function Page() {
  return (
    <Suspense fallback={<p className="p-8">Loading…</p>}>
      <SettingsScreen />
    </Suspense>
  );
}
