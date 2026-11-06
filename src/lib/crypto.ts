import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

// Crockford base32: no I, L, O, U.
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const KEY_RE = /^TWAZ-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function generateKey(): string {
  const group = () => Array.from({ length: 4 }, () => CROCKFORD[randomInt(CROCKFORD.length)]).join("");
  return `TWAZ-${group()}-${group()}-${group()}`;
}

/** Uppercases, strips whitespace and applies Crockford aliases. Returns null if not a valid key. */
export function normalizeKey(input: string): string | null {
  const s = input.toUpperCase().replace(/\s+/g, "");
  const [prefix, ...rest] = s.split("-");
  const k = [prefix, ...rest.map((g) => g.replace(/O/g, "0").replace(/[IL]/g, "1"))].join("-");
  return KEY_RE.test(k) ? k : null;
}

/** First group after TWAZ-, stored in clear for admin lookup. */
export const keyPrefix = (key: string) => key.slice(5, 9);

export const DOWNLOAD_TTL_S = 300;

function downloadSig(exp: number, filename: string, secret: string) {
  return createHmac("sha256", secret).update(`${exp}:${filename}`).digest("hex");
}

// shortcut: the link is bound to expiry + filename, not to the user; anyone holding it can use it for 5 minutes.
export function signDownload(filename: string, secret: string, nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000) + DOWNLOAD_TTL_S;
  return { exp, sig: downloadSig(exp, filename, secret) };
}

export function verifyDownload(exp: string | null, sig: string | null, filename: string, secret: string, nowMs = Date.now()) {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const e = Number(exp);
  const now = Math.floor(nowMs / 1000);
  if (e < now || e > now + DOWNLOAD_TTL_S) return false;
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(downloadSig(e, filename, secret), "hex"));
}
