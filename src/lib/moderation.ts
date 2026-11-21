import type { Prisma } from "@prisma/client";
import { displayName } from "./crypto";
import { adminEmails, parseEmailList } from "./admin";

export const MODERATION_AUDIT = {
  adminGranted: "ADMIN_GRANTED",
  adminRevoked: "ADMIN_REVOKED",
  adminPowersChanged: "ADMIN_POWERS_CHANGED",
  kickRequested: "PLAYER_KICK_REQUESTED",
  banned: "PLAYER_BANNED",
  unbanned: "PLAYER_UNBANNED",
  commandAcked: "COMMAND_ACKED",
} as const;

export const GAME_POWER_KEYS = ["teleport", "godMode", "spawnItems", "kick", "ban"] as const;
export const POWER_KEYS = [...GAME_POWER_KEYS, "bugReports"] as const;
export type GamePower = (typeof GAME_POWER_KEYS)[number];
export type Power = (typeof POWER_KEYS)[number];
export type GamePowers = Record<GamePower, boolean>;
export type Powers = Record<Power, boolean>;
export const ALL_POWERS: Powers = { teleport: true, godMode: true, spawnItems: true, kick: true, ban: true, bugReports: true };
export const NO_POWERS: Powers = { teleport: false, godMode: false, spawnItems: false, kick: false, ban: false, bugReports: false };

/** In-game roster payload: the original five keys only. `bugReports` is a panel power and is never sent to dedicated servers. */
export const gamePowers = (p: Powers): GamePowers => ({
  teleport: p.teleport, godMode: p.godMode, spawnItems: p.spawnItems, kick: p.kick, ban: p.ban,
});

export const KICK_TTL_MS = 5 * 60_000;
export const BAN_MAX_REASON = 200;
const ROSTER_MAX_COMMANDS = 100;

export type Level = "owner" | "admin" | "game" | "none";
export type Standing = {
  id: string;
  level: Level;
  /** Where the standing comes from; null for level "none". "site" = role ADMIN without ADMIN_EMAILS. */
  source: "owner" | "env" | "site" | "panel" | null;
  verified: boolean;
  /** role ADMIN and in ADMIN_EMAILS (verified or not). */
  envAdmin: boolean;
  /** verified + role ADMIN: may see full emails. */
  siteAdmin: boolean;
  /** A GameAdmin row exists. */
  hasRow: boolean;
  onRoster: boolean;
  powers: Powers;
};

type UserLike = { id: string; email: string; role: string; emailVerifiedAt: Date | null };
type PowerRow = Partial<Powers>;

export const pickPowers = (row: PowerRow | null | undefined): Powers => ({
  teleport: row?.teleport === true,
  godMode: row?.godMode === true,
  spawnItems: row?.spawnItems === true,
  kick: row?.kick === true,
  ban: row?.ban === true,
  bugReports: row?.bugReports === true,
});

/**
 * Role + powers of one account, recomputed from the database row and the env on every request. Fails closed:
 * an unverified account has no standing, and the owner needs verified + role ADMIN + ADMIN_EMAILS + OWNER_EMAILS
 * (an unset or empty OWNER_EMAILS means nobody is owner; it never falls back to ADMIN_EMAILS).
 */
export function computeStanding(
  u: UserLike,
  row: PowerRow | null,
  env: { admin?: string | undefined; owner?: string | undefined } = { admin: process.env.ADMIN_EMAILS, owner: process.env.OWNER_EMAILS },
): Standing {
  const email = u.email.trim().toLowerCase();
  const verified = !!u.emailVerifiedAt;
  const envAdmin = u.role === "ADMIN" && adminEmails(env.admin).has(email);
  const siteAdmin = verified && u.role === "ADMIN";
  const hasRow = !!row;
  const base = { id: u.id, verified, envAdmin, siteAdmin, hasRow };
  if (!verified) return { ...base, level: "none", source: null, onRoster: false, powers: NO_POWERS };
  if (siteAdmin && envAdmin && parseEmailList(env.owner).has(email)) {
    return { ...base, level: "owner", source: "owner", onRoster: true, powers: ALL_POWERS };
  }
  if (siteAdmin) {
    return { ...base, level: "admin", source: envAdmin ? "env" : "site", onRoster: envAdmin || hasRow, powers: row ? pickPowers(row) : envAdmin ? ALL_POWERS : NO_POWERS };
  }
  if (row) return { ...base, level: "game", source: "panel", onRoster: true, powers: pickPowers(row) };
  return { ...base, level: "none", source: null, onRoster: false, powers: NO_POWERS };
}

type Db = Prisma.TransactionClient;

export async function loadStanding(db: Db, u: UserLike): Promise<Standing> {
  return computeStanding(u, await db.gameAdmin.findUnique({ where: { userId: u.id } }));
}

export async function loadStandingById(db: Db, id: string): Promise<{ user: UserLike; standing: Standing } | null> {
  const user = await db.user.findUnique({ where: { id }, select: { id: true, email: true, role: true, emailVerifiedAt: true, gameAdmin: true } });
  return user ? { user, standing: computeStanding(user, user.gameAdmin) } : null;
}

// ---- Permission matrix (pure) ----
export const canAccessPanel = (a: Standing) => a.level !== "none";
export const canSeeEmails = (a: Standing) => a.level === "owner" || a.siteAdmin;
/** Anyone who is, or is configured as, an admin. */
const adminish = (t: Standing) => t.level !== "none" || t.envAdmin || t.hasRow;
export const canPromote = (a: Standing, t: Standing) => canAccessPanel(a) && a.id !== t.id && !adminish(t) && t.verified;
export const canDemote = (a: Standing, t: Standing) => a.level === "owner" && a.id !== t.id && t.level !== "owner" && t.hasRow && !t.envAdmin;
export const canSetPowers = (a: Standing, t: Standing) => a.level === "owner" && a.id !== t.id && t.level !== "owner" && (t.envAdmin || t.hasRow);
/** Kick and ban share target rules: never self or the owner; admins only for the owner. */
const targetable = (a: Standing, t: Standing) => a.id !== t.id && t.level !== "owner" && (!adminish(t) || a.level === "owner");
export const canKick = (a: Standing, t: Standing) => a.powers.kick && targetable(a, t);
export const canBan = (a: Standing, t: Standing) => a.powers.ban && targetable(a, t);
/** Owner always has this (ALL_POWERS). Everyone else needs the `bugReports` power. */
export const canAccessBugReports = (a: Standing) => a.powers.bugReports === true;

/** Full address for site admins and the owner, `n***@domain` for everyone else. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 1 ? "***" : `${email[0]}***${email.slice(at)}`;
}
export const emailFor = (viewer: Standing, email: string) => (canSeeEmails(viewer) ? email : maskEmail(email));

// ---- Bans ----
export type BanLike = { revokedAt: Date | null; expiresAt: Date | null };
export const banActive = (b: BanLike, now: Date = new Date()) => b.revokedAt === null && (b.expiresAt === null || b.expiresAt.getTime() > now.getTime());
export const activeBanWhere = (now: Date) => ({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
/** The latest end among active bans: null (permanent) wins. */
export function banExpiry(bans: { expiresAt: Date | null }[]): Date | null {
  if (bans.some((b) => b.expiresAt === null)) return null;
  return bans.reduce<Date | null>((m, b) => (!m || b.expiresAt! > m ? b.expiresAt : m), null);
}
export const banExpiryFromMinutes = (minutes: number | null, now: Date = new Date()) => (minutes === null ? null : new Date(now.getTime() + minutes * 60_000));

// ---- Counters ----
export const counterKey = { roster: "roster", bans: "bans", commands: (serverId: string) => `commands:${serverId}` } as const;

export async function bump(tx: Db, key: string) {
  await tx.$executeRaw`INSERT INTO "ModerationCounter" ("key", "value") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = "ModerationCounter"."value" + 1`;
}

export async function counters(tx: Db, serverId: string) {
  const rows = await tx.moderationCounter.findMany({ where: { key: { in: [counterKey.roster, counterKey.bans, counterKey.commands(serverId)] } } });
  const v = (k: string) => rows.find((r) => r.key === k)?.value ?? 0;
  return { rosterVersion: v(counterKey.roster), bansVersion: v(counterKey.bans), commandsVersion: v(counterKey.commands(serverId)) };
}

/** Orders a ban decision against a concurrent ban: a ban commits either before this decision sees it or after it finished. */
export async function lockBans(tx: Db) {
  await tx.$queryRaw`SELECT 1 FROM "ModerationCounter" WHERE "key" = 'bans' FOR SHARE`;
}

/** Accounts of `userIds` with an active global ban or one scoped to `serverId`. */
export async function bannedAmong(tx: Db, userIds: string[], serverId: string, now = new Date()) {
  if (userIds.length === 0) return new Map<string, Date | null>();
  const bans = await tx.playerBan.findMany({
    where: { userId: { in: userIds }, ...activeBanWhere(now), AND: [{ OR: [{ serverId: null }, { serverId }] }] },
    select: { userId: true, expiresAt: true },
  });
  const by = new Map<string, { expiresAt: Date | null }[]>();
  for (const b of bans) by.set(b.userId, [...(by.get(b.userId) ?? []), b]);
  return new Map([...by].map(([id, list]) => [id, banExpiry(list)]));
}

const audit = (tx: Db, action: string, actorId: string | null, targetId: string, meta: Prisma.InputJsonObject) =>
  tx.auditLog.create({ data: { actorId, action, targetId, meta } });

// ---- Roster ----
export type RosterEntry = { accountId: string; displayName: string; role: "owner" | "admin"; powers: GamePowers };

/** Verified accounts on the roster: the owner, env admins, game admins. Same computation the in-game ban check uses. */
export async function rosterUsers(tx: Db) {
  const envList = [...adminEmails()];
  const users = await tx.user.findMany({
    where: { emailVerifiedAt: { not: null }, OR: [{ gameAdmin: { isNot: null } }, ...(envList.length ? [{ role: "ADMIN" as const, email: { in: envList } }] : [])] },
    select: { id: true, email: true, role: true, emailVerifiedAt: true, gameAdmin: true },
  });
  return users
    .map((u) => ({ u, s: computeStanding(u, u.gameAdmin) }))
    .filter(({ s }) => s.onRoster && s.level !== "none")
    .sort((a, b) => (a.u.id < b.u.id ? -1 : 1));
}

/** Sorted by accountId; the owner appears once. */
export async function rosterEntries(tx: Db): Promise<RosterEntry[]> {
  return (await rosterUsers(tx)).map(({ u, s }) => ({ accountId: u.id, displayName: displayName(u.id), role: s.level === "owner" ? ("owner" as const) : ("admin" as const), powers: gamePowers(s.powers) }));
}

export async function pendingCommands(tx: Db, serverId: string, now = new Date()) {
  const rows = await tx.serverCommand.findMany({
    where: { serverId, ackedAt: null, expiresAt: { gt: now } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: ROSTER_MAX_COMMANDS,
  });
  return rows.map((c) => ({ id: c.id, type: "kick" as const, accountId: c.userId, reason: c.reason, createdAt: c.createdAt.toISOString(), expiresAt: c.expiresAt.toISOString() }));
}

// ---- Mutations (each runs in the caller's transaction; the caller commits) ----
export type Fail = { ok: false; error: "forbidden" | "not_found" | "unknown_account" | "conflict" };
const fail = (error: Fail["error"]): Fail => ({ ok: false, error });

export async function promote(tx: Db, actorId: string, email: string) {
  const actor = await loadStandingById(tx, actorId);
  const user = await tx.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true, email: true, role: true, emailVerifiedAt: true } });
  if (!actor || !canAccessPanel(actor.standing)) return fail("forbidden");
  if (!user) return fail("unknown_account");
  const target = await loadStanding(tx, user);
  if (target.level === "none" && !target.verified) return fail("unknown_account"); // unverified accounts are indistinguishable from unknown ones
  if (adminish(target)) return fail("conflict");
  if (!canPromote(actor.standing, target)) return fail("forbidden");
  const made = await tx.gameAdmin.createMany({ data: [{ userId: user.id, grantedById: actorId }], skipDuplicates: true });
  if (made.count === 0) return fail("conflict");
  await bump(tx, counterKey.roster);
  await audit(tx, MODERATION_AUDIT.adminGranted, actorId, user.id, { old: null, new: NO_POWERS, source: "web" });
  return { ok: true as const, userId: user.id };
}

export async function demote(tx: Db, actorId: string, targetId: string) {
  const actor = await loadStandingById(tx, actorId);
  const target = await loadStandingById(tx, targetId);
  if (!actor || !target) return fail(actor ? "not_found" : "forbidden");
  if (!canDemote(actor.standing, target.standing)) return fail(target.standing.hasRow || target.standing.level === "owner" || target.standing.envAdmin ? "forbidden" : "not_found");
  const old = await tx.gameAdmin.findUnique({ where: { userId: targetId } });
  const gone = await tx.gameAdmin.deleteMany({ where: { userId: targetId } });
  if (gone.count === 0) return fail("not_found");
  await bump(tx, counterKey.roster);
  await audit(tx, MODERATION_AUDIT.adminRevoked, actorId, targetId, { old: pickPowers(old), new: null, source: "web" });
  return { ok: true as const };
}

export async function setPowers(tx: Db, actorId: string, targetId: string, next: Powers) {
  const actor = await loadStandingById(tx, actorId);
  const target = await loadStandingById(tx, targetId);
  if (!actor || !target) return fail(actor ? "not_found" : "forbidden");
  if (!canSetPowers(actor.standing, target.standing)) return fail(target.standing.level === "none" && !target.standing.envAdmin && !target.standing.hasRow ? "not_found" : "forbidden");
  const old = target.standing.powers;
  if (POWER_KEYS.every((k) => old[k] === next[k]) && target.standing.hasRow) return { ok: true as const, changed: false };
  await tx.gameAdmin.upsert({ where: { userId: targetId }, create: { userId: targetId, ...next, grantedById: actorId }, update: next });
  await bump(tx, counterKey.roster);
  await audit(tx, MODERATION_AUDIT.adminPowersChanged, actorId, targetId, { old, new: next, source: "web" });
  return { ok: true as const, changed: true };
}

/** Kick commands for one account on each server. Bumps each server's commandsVersion. */
export async function queueKicks(tx: Db, o: { userId: string; serverIds: string[]; reason: string | null; createdById: string | null; banId?: string }) {
  const expiresAt = new Date(Date.now() + KICK_TTL_MS);
  for (const serverId of o.serverIds) {
    await tx.serverCommand.create({ data: { serverId, type: "kick", userId: o.userId, reason: o.reason, createdById: o.createdById, banId: o.banId, expiresAt } });
    await bump(tx, counterKey.commands(serverId));
  }
  return o.serverIds.length;
}

export async function requestKick(tx: Db, actorId: string, serverId: string, targetId: string, reason: string | null) {
  const actor = await loadStandingById(tx, actorId);
  const target = await loadStandingById(tx, targetId);
  if (!actor || !canAccessPanel(actor.standing)) return fail("forbidden");
  if (!target) return fail("unknown_account");
  if (!canKick(actor.standing, target.standing)) return fail("forbidden");
  const server = await tx.officialServer.findUnique({ where: { id: serverId }, select: { status: true } });
  if (server?.status !== "ACTIVE") return fail("not_found");
  await queueKicks(tx, { userId: targetId, serverIds: [serverId], reason, createdById: actorId });
  await audit(tx, MODERATION_AUDIT.kickRequested, actorId, targetId, { old: null, new: { kick: true }, reason, source: "web", serverId });
  return { ok: true as const };
}

/**
 * One ban path for the panel and the in-game /ban write-back. Global unless `serverId` scopes it (panel only).
 * Takes the exclusive "bans" counter lock before inserting: a join/admit decision holding FOR SHARE either sees nothing
 * and finishes first (the queued kick then removes the player), or waits and sees the ban.
 */
export async function createBan(tx: Db, o: { actorId: string; targetId: string; reason: string | null; durationMinutes: number | null; serverId: string | null; source: "web" | "game"; viaServerId?: string }) {
  const actor = await loadStandingById(tx, o.actorId);
  const target = await loadStandingById(tx, o.targetId);
  if (!actor || !actor.standing.powers.ban) return fail("forbidden");
  if (!target) return fail("unknown_account");
  if (!canBan(actor.standing, target.standing)) return fail("forbidden");
  if (o.serverId) {
    const s = await tx.officialServer.findUnique({ where: { id: o.serverId }, select: { status: true } });
    if (!s) return fail("not_found");
  }
  await bump(tx, counterKey.bans);
  const now = new Date();
  const expiresAt = banExpiryFromMinutes(o.durationMinutes, now);
  const ban = await tx.playerBan.create({ data: { userId: o.targetId, serverId: o.serverId, reason: o.reason, expiresAt, createdById: o.actorId } });
  const serverIds = o.serverId
    ? [o.serverId]
    : (await tx.officialServer.findMany({ where: { status: "ACTIVE" }, select: { id: true }, orderBy: { id: "asc" } })).map((s) => s.id);
  const queuedKicks = await queueKicks(tx, { userId: o.targetId, serverIds, reason: o.reason ?? "banned", createdById: o.actorId, banId: ban.id });
  await audit(tx, MODERATION_AUDIT.banned, o.actorId, o.targetId, {
    old: null, new: { active: true }, source: o.source, serverId: o.viaServerId ?? o.serverId, scope: o.serverId ? "server" : "global",
    banId: ban.id, reason: o.reason, expiresAt: expiresAt?.toISOString() ?? null, durationMinutes: o.durationMinutes, queuedKicks,
  });
  return { ok: true as const, ban, queuedKicks };
}

export async function unban(tx: Db, actorId: string, banId: string, revokeReason: string | null = null) {
  const actor = await loadStandingById(tx, actorId);
  if (!actor || !actor.standing.powers.ban) return fail("forbidden");
  const ban = await tx.playerBan.findUnique({ where: { id: banId } });
  if (!ban || !banActive(ban)) return fail("not_found");
  await bump(tx, counterKey.bans);
  const r = await tx.playerBan.updateMany({ where: { id: banId, revokedAt: null }, data: { revokedAt: new Date(), revokedById: actorId, revokeReason } });
  if (r.count === 0) return fail("not_found");
  await audit(tx, MODERATION_AUDIT.unbanned, actorId, ban.userId, { old: { active: true }, new: { active: false }, source: "web", banId, serverId: ban.serverId });
  return { ok: true as const };
}
