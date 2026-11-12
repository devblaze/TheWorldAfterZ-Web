import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sha256 } from "./crypto";

export const SERVER_AUDIT = {
  created: "SERVER_CREATED",
  rotated: "SERVER_SECRET_ROTATED",
  disabled: "SERVER_DISABLED",
  compatUpdated: "SERVER_COMPAT_UPDATED",
  // Admission audit names; issued by join-ticket, admit and sessions/*.
  ticketIssued: "TICKET_ISSUED",
  admitOk: "ADMIT_OK",
  admitDeny: "ADMIT_DENY",
  ticketReuse: "TICKET_REUSE",
  playerKick: "PLAYER_KICK",
} as const;

export const CLIENT_PLATFORMS = ["win-x64", "linux-x64"] as const;
export const HEARTBEAT_LIMIT = { perServer: 4, windowMs: 60_000 } as const;
export const heartbeatKey = (serverId: string) => `server-heartbeat:${serverId}`;
/** Per-server fixed-window limits, counted after the credential check. check allows batched 256-id polls at the 10000-player registry cap; end allows disconnect bursts. */
export const SERVER_LIMITS = {
  admit: { prefix: "server-admit", limit: 60, windowMs: 60_000 },
  check: { prefix: "server-check", limit: 120, windowMs: 60_000 },
  end: { prefix: "server-end", limit: 600, windowMs: 60_000 },
} as const;
export const CHECK_MAX_IDS = 256;
export const MAX_PLAYERS = 10_000;
/** Online = last heartbeat within this window. */
export const ONLINE_MS = 90_000;
export const JOIN_TICKET_TTL_MS = 60_000;
export const DIRECTORY_MAX = 64;

/** 32 random bytes, base64url. The plaintext leaves the server once, in the create/rotate response. */
export const newServerSecret = () => randomBytes(32).toString("base64url");

export const SERVER_ID = /^[a-z0-9]{1,64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/** Parses `TwazServer <serverId>.<secret>`; null on any deviation. */
export function parseServerAuth(header: string | null): { serverId: string; secret: string } | null {
  if (!header || header.length > 256) return null;
  const m = /^TwazServer ([^.\s]+)\.(\S+)$/.exec(header.trim());
  if (!m || !SERVER_ID.test(m[1]) || !SECRET_RE.test(m[2])) return null;
  return { serverId: m[1], secret: m[2] };
}

const DUMMY_HASH = sha256("no-such-server");

/** Constant-time compare of sha256(secret) against the stored hex hash. A missing hash still does the compare. */
export function secretMatches(secret: string, storedHash: string | null | undefined): boolean {
  const a = Buffer.from(sha256(secret), "hex");
  const validHash = typeof storedHash === "string" && /^[0-9a-f]{64}$/.test(storedHash);
  const b = Buffer.from(validHash ? storedHash : DUMMY_HASH, "hex");
  return timingSafeEqual(a, b) && validHash;
}

const label = (max: number) => z.string().trim().min(1).max(max).regex(/^[\w .-]+$/);
const buildId = z.string().trim().min(1).max(64).regex(/^[\w.+-]+$/);
const protocolVersion = z.number().int().min(1).max(1_000_000);
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export const Compat = z.object({
  gameBuild: buildId,
  buildFamily: buildId,
  protocolVersion,
  clientPlatforms: z.array(z.enum(CLIENT_PLATFORMS)).min(1).max(CLIENT_PLATFORMS.length)
    .refine((a) => new Set(a).size === a.length, "duplicate platform"),
});

export const CreateServer = Compat.extend({
  name: label(64),
  region: label(32),
  host: z.string().trim().toLowerCase().max(253).refine((h) => HOST_RE.test(h) || z.ipv6().safeParse(h).success, "invalid host"),
  port: z.number().int().min(1).max(65535),
});

const nonce = z.string().min(16).max(128).regex(/^[\x21-\x7e]+$/);
const informational = z.string().min(1).max(64).regex(/^[\x21-\x7e]+$/);
/** game_build stamp: 1–128 printable ASCII, matching the contract $defs/stamp and admit/join. */
const stamp = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/);

export const Heartbeat = z.object({
  game_build: stamp,
  build_family: z.string().min(1).max(64),
  protocol_version: protocolVersion,
  server_runtime: informational,
  instance_nonce: nonce,
  players: z.number().int().min(0).max(MAX_PLAYERS),
  maxPlayers: z.number().int().min(1).max(MAX_PLAYERS),
}).refine((b) => b.players <= b.maxPlayers);

// Launcher-supplied build fields, shapes from the LAUNCHER freeze $defs (family, protocol, platform, stamp).
const launcherBuild = {
  build_family: z.string().min(1).max(64),
  protocol_version: protocolVersion,
  client_platform: z.enum(CLIENT_PLATFORMS),
  game_build: z.string().min(1).max(128),
};
const base64urlId = (min: number, max: number) => z.string().min(min).max(max).regex(/^[A-Za-z0-9_-]+$/);

export const JoinTicketRequest = z.object({ serverId: base64urlId(1, 128), nonce: base64urlId(16, 128), ...launcherBuild });
const DirectoryQuery = z.object(launcherBuild);

/** Each of the four params exactly once; protocol_version as a plain decimal integer. */
export function parseDirectoryQuery(q: URLSearchParams) {
  const one = (k: string) => {
    const v = q.getAll(k);
    return v.length === 1 ? v[0] : undefined;
  };
  const pv = one("protocol_version");
  return DirectoryQuery.safeParse({
    build_family: one("build_family"),
    protocol_version: pv !== undefined && /^[1-9][0-9]{0,6}$/.test(pv) ? Number(pv) : pv,
    client_platform: one("client_platform"),
    game_build: one("game_build"),
  });
}

const MAX_U64 = "18446744073709551615";
const sessionId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

/** `ticket` is only length-bounded: a client-relayed garbage ticket must reach ticket_invalid, not a 400. */
export const AdmitRequest = z.strictObject({
  ticket: z.string().min(1).max(256),
  instance_nonce: nonce,
  connection_id: z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine((v) => v.length < 20 || v <= MAX_U64),
  build_family: z.string().min(1).max(64),
  protocol_version: protocolVersion,
  game_build: stamp,
});
export const CheckRequest = z.strictObject({ serverSessionIds: z.array(sessionId).max(CHECK_MAX_IDS) });
export const EndRequest = z.strictObject({ serverSessionId: sessionId, reason: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/) });
