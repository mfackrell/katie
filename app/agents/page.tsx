import { redirect } from "next/navigation";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const p = await searchParams;
  if (typeof p.mission === "string")
    redirect(`/settings/advanced?mission=${encodeURIComponent(p.mission)}`);
  if (typeof p.task === "string")
    redirect(`/settings/advanced?task=${encodeURIComponent(p.task)}`);
  redirect("/settings/advanced");
}
