import { prisma } from "./db";

/** Client IP as seen by our reverse proxy: X-Real-IP, else the last X-Forwarded-For hop (earlier hops are client-controlled). */
export function ipFrom(h: Headers) {
  return h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",").pop()?.trim() || "unknown";
}

export type Hit = (key: string, windowStart: Date) => Promise<number>;

// Atomic fixed-window counter: resets when the stored window differs from the current one.
const pgHit: Hit = async (key, windowStart) => {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "windowStart", "count") VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimit"."windowStart" = EXCLUDED."windowStart" THEN "RateLimit"."count" + 1 ELSE 1 END,
      "windowStart" = EXCLUDED."windowStart"
    RETURNING "count"`;
  return rows[0].count;
};

export const windowStart = (nowMs: number, windowMs: number) => new Date(nowMs - (nowMs % windowMs));

/** Counts one attempt; returns true while the key is within `limit` attempts for the current window. */
export async function rateLimit(key: string, limit: number, windowMs: number, nowMs = Date.now(), hit: Hit = pgHit) {
  return (await hit(key, windowStart(nowMs, windowMs))) <= limit;
}

const MIN15 = 15 * 60_000;
const HOUR = 60 * 60_000;

export function retryAfterSeconds(windowMs: number, now = Date.now()) {
  const start = windowStart(now, windowMs).getTime();
  return Math.max(1, Math.ceil((start + windowMs - now) / 1000));
}

export type Gate = { ok: true } | { ok: false; retryAfter: number };
const gate = (ok: boolean, windowMs: number): Gate => (ok ? { ok: true } : { ok: false, retryAfter: retryAfterSeconds(windowMs) });

// Launcher ceilings on the same fixed-window counter. Numbers are per 15 minutes.
// Token client is the public client id (one shared bucket). Refresh session is the family id.
export const LAUNCHER_LIMITS = {
  token: { ip: 100, client: 2000, windowMs: MIN15 },
  refresh: { ip: 120, session: 30, windowMs: MIN15 },
  play: { ip: 120, account: 120, windowMs: MIN15 },
  authorize: { account: 60, windowMs: MIN15 },
} as const;

export const launcherTokenIpKey = (ip: string) => `launcher-token:ip:${ip}`;
export const launcherTokenClientKey = (clientId: string) => `launcher-token:client:${clientId}`;
export const launcherRefreshIpKey = (ip: string) => `launcher-refresh:ip:${ip}`;
export const launcherRefreshSidKey = (sid: string) => `launcher-refresh:sid:${sid}`;
export const launcherPlayIpKey = (ip: string) => `launcher-play:ip:${ip}`;
export const launcherPlayAccountKey = (accountId: string) => `launcher-play:acct:${accountId}`;
export const launcherAuthorizeAccountKey = (userId: string) => `launcher-authorize:acct:${userId}`;

export const limitLauncherTokenIp = (ip: string) => {
  const l = LAUNCHER_LIMITS.token;
  return rateLimit(launcherTokenIpKey(ip), l.ip, l.windowMs).then((ok) => gate(ok, l.windowMs));
};

export async function limitLauncherToken(ip: string, clientId: string): Promise<Gate> {
  const l = LAUNCHER_LIMITS.token;
  const [ipOk, clientOk] = await Promise.all([
    rateLimit(launcherTokenIpKey(ip), l.ip, l.windowMs),
    rateLimit(launcherTokenClientKey(clientId), l.client, l.windowMs),
  ]);
  return gate(ipOk && clientOk, l.windowMs);
}

export const limitLauncherRefreshIp = (ip: string) => {
  const l = LAUNCHER_LIMITS.refresh;
  return rateLimit(launcherRefreshIpKey(ip), l.ip, l.windowMs).then((ok) => gate(ok, l.windowMs));
};

export const limitLauncherRefreshSid = (sid: string) => {
  const l = LAUNCHER_LIMITS.refresh;
  return rateLimit(launcherRefreshSidKey(sid), l.session, l.windowMs).then((ok) => gate(ok, l.windowMs));
};

export async function limitLauncherPlay(ip: string, accountId: string): Promise<Gate> {
  const l = LAUNCHER_LIMITS.play;
  const [ipOk, accountOk] = await Promise.all([
    rateLimit(launcherPlayIpKey(ip), l.ip, l.windowMs),
    rateLimit(launcherPlayAccountKey(accountId), l.account, l.windowMs),
  ]);
  return gate(ipOk && accountOk, l.windowMs);
}

export const limitLauncherAuthorize = (userId: string) => {
  const l = LAUNCHER_LIMITS.authorize;
  return rateLimit(launcherAuthorizeAccountKey(userId), l.account, l.windowMs).then((ok) => gate(ok, l.windowMs));
};

export const LIMITS = {
  login: { ip: 20, account: 5, windowMs: MIN15 },
  register: { ip: 5, account: 3, windowMs: HOUR },
  redeem: { ip: 10, account: 5, windowMs: MIN15 },
  resend: { ip: 5, account: 3, windowMs: HOUR },
  forgot: { ip: 5, account: 3, windowMs: HOUR },
} as const;

/** Per-IP only, for actions with no account identifier (the reset token is the secret). */
export const IP_LIMITS = { reset: { ip: 10, windowMs: MIN15 } } as const;
export const limitIp = (action: keyof typeof IP_LIMITS, ip: string) =>
  rateLimit(`${action}:ip:${ip}`, IP_LIMITS[action].ip, IP_LIMITS[action].windowMs);

/** Per-IP and per-account check; both counters are always incremented. */
export async function limitBoth(action: keyof typeof LIMITS, ip: string, account: string) {
  const l = LIMITS[action];
  const [a, b] = await Promise.all([
    rateLimit(`${action}:ip:${ip}`, l.ip, l.windowMs),
    rateLimit(`${action}:acct:${account}`, l.account, l.windowMs),
  ]);
  return a && b;
}
