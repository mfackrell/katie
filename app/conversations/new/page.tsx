import { Suspense } from "react";
import { NewConversationScreen } from "@/components/workspace-screens";
export default function Page() {
  return (
    <Suspense fallback={<p className="p-8">Loading…</p>}>
      <NewConversationScreen />
    </Suspense>
  );
}
