import { sha256 } from "./crypto";

/** JSON with object keys sorted at every depth; array order is kept. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Strong ETag of a response body. */
export const etagFor = (body: unknown) => `"${sha256(canonicalJson(body)).slice(0, 32)}"`;

/** RFC 9110 If-None-Match with weak comparison: `*`, a comma list, and W/ prefixes. */
export function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => strip(t) === etag);
}
