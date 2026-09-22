/** Put an email back in the queue to be read again. */
import { retryEmail } from "@/lib/price-pipeline";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const ok = await retryEmail(params.id);
    return ok
      ? Response.json({ ok: true })
      : Response.json({ error: "kunne ikke settes i kø på nytt" }, { status: 409 });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
