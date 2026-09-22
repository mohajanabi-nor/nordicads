/** The Logg tab: paginated events, newest first. Read-only. */
import { markLogsSeen, readEvents, unseenErrorCount, type LogLevel, type LogSource } from "@/lib/eventlog";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;

    // A HEAD-like poll for the nav badge: cheap, and must not mark anything read.
    if (sp.get("badge") === "1") {
      return Response.json({ unseenErrors: await unseenErrorCount() });
    }

    const result = await readEvents({
      page: parseInt(sp.get("page") ?? "1", 10) || 1,
      pageSize: parseInt(sp.get("pageSize") ?? "50", 10) || 50,
      level: (sp.get("level") ?? "alle") as LogLevel | "alle",
      source: (sp.get("source") ?? "alle") as LogSource | "alle",
      q: sp.get("q") ?? "",
    });

    // Opening the tab is what clears the badge. Awaited because a hosted
    // function can be frozen as soon as it responds, and a lost write here
    // means the badge never clears.
    if (sp.get("markSeen") === "1") await markLogsSeen();

    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
