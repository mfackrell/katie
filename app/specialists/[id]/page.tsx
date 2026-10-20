import { SpecialistsScreen } from "@/components/workspace-screens";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SpecialistsScreen id={decodeURIComponent(id)} />;
}
