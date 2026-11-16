import { methodNotAllowed } from "@/lib/launcher/http";
import { counters, pendingCommands } from "@/lib/moderation";
import { serverGet } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notAllowed = methodNotAllowed("GET");
export { notAllowed as POST, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE, notAllowed as OPTIONS };

export const GET = async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  serverGet(req, "commands", (await ctx.params).id, async (tx, serverId) => ({
    version: (await counters(tx, serverId)).commandsVersion,
    commands: await pendingCommands(tx, serverId),
  }));
