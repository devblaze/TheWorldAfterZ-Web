import { prisma } from "@/lib/db";
import { bugReportsAdminOrNull, json } from "@/lib/session";
import { bugReportsUnavailableResponse, checkBugReportStorage, getBugReportBlob } from "@/lib/bug-report-storage";
import { REPLAY_CONTENT_TYPE, REPORT_ID_RE } from "@/lib/bug-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await bugReportsAdminOrNull();
  if (!admin) return json({ error: "forbidden" }, 403);
  const storage = await checkBugReportStorage();
  if (!storage.ok) return bugReportsUnavailableResponse();
  const { id } = await params;
  if (!REPORT_ID_RE.test(id)) return json({ error: "not_found" }, 404);
  const row = await prisma.bugReport.findUnique({
    where: { id },
    select: { replayKey: true, replayContentType: true, replayBytes: true },
  });
  if (!row?.replayKey) return json({ error: "not_found" }, 404);
  const bytes = await getBugReportBlob(row.replayKey);
  if (!bytes) return json({ error: "not_found" }, 404);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": row.replayContentType ?? REPLAY_CONTENT_TYPE,
      "Content-Length": String(row.replayBytes ?? bytes.length),
      "Content-Disposition": `attachment; filename="${id}-replay.ndjson.gz"`,
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });
}
