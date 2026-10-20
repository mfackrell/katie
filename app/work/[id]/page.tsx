import { Suspense } from "react";
import { WorkDetailScreen } from "@/components/workspace-screens";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<p className="p-8">Loading…</p>}>
      <WorkDetailScreen reference={decodeURIComponent(id)} />
    </Suspense>
  );
}
