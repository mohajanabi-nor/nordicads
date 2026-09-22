/** Campaign history for the e-post page. Read-only. */
import { listCampaigns } from "@/lib/campaign-store";
import { isDryRun } from "@/lib/resend";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ dryRun: isDryRun(), campaigns: await listCampaigns() });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
