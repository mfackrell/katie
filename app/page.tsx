import { HomeScreen } from "@/components/workspace-screens";
import Legacy from "@/app/legacy/page";
export default function Page() {
  return process.env.KATIE_WORKSPACE_UI === "legacy" ? (
    <Legacy />
  ) : (
    <HomeScreen />
  );
}
