import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sha256 } from "./crypto";

export const SERVER_AUDIT = {
  created: "SERVER_CREATED",
  rotated: "SERVER_SECRET_ROTATED",
  disabled: "SERVER_DISABLED",
  compatUpdated: "SERVER_COMPAT_UPDATED",
  // Reserved for admission (steps 3-5), listed here so the action names live in one place.
  ticketIssued: "TICKET_ISSUED",
  admitOk: "ADMIT_OK",
  admitDeny: "ADMIT_DENY",
  ticketReuse: "TICKET_REUSE",
  playerKick: "PLAYER_KICK",
} as const;

export const CLIENT_PLATFORMS = ["win-x64", "linux-x64"] as const;
export const HEARTBEAT_LIMIT = { perServer: 4, windowMs: 60_000 } as const;
export const heartbeatKey = (serverId: string) => `server-heartbeat:${serverId}`;
export const MAX_PLAYERS = 10_000;

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

const informational = z.string().min(1).max(64).regex(/^[\x21-\x7e]+$/);

export const Heartbeat = z.object({
  game_build: informational,
  build_family: z.string().min(1).max(64),
  protocol_version: protocolVersion,
  server_runtime: informational,
  instance_nonce: z.string().min(16).max(128).regex(/^[\x21-\x7e]+$/),
  players: z.number().int().min(0).max(MAX_PLAYERS),
  maxPlayers: z.number().int().min(1).max(MAX_PLAYERS),
}).refine((b) => b.players <= b.maxPlayers);
