import { prisma } from "@/lib/db";
import { bugReportsAdminOrNull, json } from "@/lib/session";
import { bugReportsUnavailableResponse, checkBugReportStorage, getBugReportBlob } from "@/lib/bug-report-storage";
import { REPORT_ID_RE, SCREENSHOT_CONTENT_TYPE } from "@/lib/bug-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const admin = await bugReportsAdminOrNull();
  if (!admin) return json({ error: "forbidden" }, 403);
  const storage = await checkBugReportStorage();
  if (!storage.ok) return bugReportsUnavailableResponse();
  const { id, index: rawIndex } = await params;
  if (!REPORT_ID_RE.test(id) || !/^\d+$/.test(rawIndex)) return json({ error: "not_found" }, 404);
  const index = Number(rawIndex);
  const shot = await prisma.bugReportScreenshot.findUnique({
    where: { reportId_index: { reportId: id, index } },
    select: { storageKey: true, contentType: true, bytes: true },
  });
  if (!shot) return json({ error: "not_found" }, 404);
  const bytes = await getBugReportBlob(shot.storageKey);
  if (!bytes) return json({ error: "not_found" }, 404);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": shot.contentType || SCREENSHOT_CONTENT_TYPE,
      "Content-Length": String(shot.bytes || bytes.length),
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Content-Disposition": `inline; filename="${id}-shot-${index}.jpg"`,
    },
  });
}
