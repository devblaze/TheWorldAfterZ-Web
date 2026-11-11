import { methodNotAllowed } from "@/lib/launcher/http";
import { serverPost } from "@/lib/server-api";
import { EndRequest } from "@/lib/servers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notAllowed = methodNotAllowed("POST");
export { notAllowed as GET, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE, notAllowed as OPTIONS };

export const POST = (req: Request) =>
  serverPost(req, "end", 1024, EndRequest, async (tx, server, b) => {
    // Only this server's open sessions change; unknown, foreign and already-ended ids are the same {ok:true}.
    await tx.serverSession.updateMany({
      where: { id: b.serverSessionId, serverId: server.id, endedAt: null },
      data: { endedAt: new Date(), endReason: b.reason },
    });
    return { ok: true };
  });
