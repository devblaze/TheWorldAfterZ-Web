import { json, seeOther } from "./session";
import type { Fail } from "./moderation";

/** Non-empty string fields of a form post; the routes zod-validate the result. */
export async function formFields(req: Request): Promise<Record<string, string>> {
  const fd = await req.formData().catch(() => null);
  return Object.fromEntries([...(fd ?? [])].filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
}

export const invalid = () => json({ error: "invalid input" }, 400);

/** forbidden / not_found stay JSON like the other admin routes; user-fixable outcomes go back to the page with a message. */
export function failed(f: Fail, back: string) {
  if (f.error === "forbidden") return json({ error: "forbidden" }, 403);
  if (f.error === "not_found") return json({ error: "not found" }, 404);
  return seeOther(`${back}${back.includes("?") ? "&" : "?"}error=${f.error}`);
}

export const done = (path: string, what: string) => seeOther(`${path}${path.includes("?") ? "&" : "?"}done=${what}`);
