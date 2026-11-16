import { describe, expect, it } from "vitest";
import { displayName } from "../src/lib/crypto";
import {
  ALL_POWERS, NO_POWERS, banActive, banExpiry, banExpiryFromMinutes, canAccessPanel, canBan, canDemote, canKick, canPromote,
  canSeeEmails, canSetPowers, computeStanding, maskEmail, type Standing,
} from "../src/lib/moderation";
import { parseEmailList } from "../src/lib/admin";
import { AckRequest, ServerBanRequest } from "../src/lib/servers";

const env: { admin?: string | undefined; owner?: string | undefined } = { admin: "boss@x.test, ops@x.test", owner: "boss@x.test" };
const user = (id: string, email: string, o: { role?: string; verified?: boolean } = {}) =>
  ({ id, email, role: o.role ?? "PLAYER", emailVerifiedAt: o.verified === false ? null : new Date() });
const st = (id: string, email: string, o: { role?: string; verified?: boolean } = {}, row: Partial<typeof ALL_POWERS> | null = null, e = env) =>
  computeStanding(user(id, email, o), row, e);

describe("computeStanding (fails closed)", () => {
  it("owner needs verified + ADMIN + ADMIN_EMAILS + OWNER_EMAILS", () => {
    const s = st("o", "Boss@x.test", { role: "ADMIN" });
    expect(s).toMatchObject({ level: "owner", source: "owner", onRoster: true, powers: ALL_POWERS });
    for (const [label, got] of [
      ["unset OWNER_EMAILS", st("o", "boss@x.test", { role: "ADMIN" }, null, { admin: env.admin, owner: undefined })],
      ["empty OWNER_EMAILS", st("o", "boss@x.test", { role: "ADMIN" }, null, { admin: env.admin, owner: " , " })],
      ["unverified", st("o", "boss@x.test", { role: "ADMIN", verified: false })],
      ["not in ADMIN_EMAILS", st("o", "boss@x.test", { role: "ADMIN" }, null, { admin: "ops@x.test", owner: env.owner })],
      ["not ADMIN", st("o", "boss@x.test", { role: "PLAYER" })],
    ] as const) expect(got.level, label).not.toBe("owner");
  });

  it("never falls back to ADMIN_EMAILS when OWNER_EMAILS is unset", () => {
    expect(st("a", "ops@x.test", { role: "ADMIN" }, null, { admin: env.admin, owner: undefined }).level).toBe("admin");
    expect(parseEmailList(undefined).size).toBe(0);
  });

  it("env admins get all powers unless a row narrows them; site admins without env get none", () => {
    expect(st("a", "ops@x.test", { role: "ADMIN" })).toMatchObject({ level: "admin", source: "env", onRoster: true, powers: ALL_POWERS });
    expect(st("a", "ops@x.test", { role: "ADMIN" }, { kick: true })).toMatchObject({ source: "env", powers: { ...NO_POWERS, kick: true } });
    expect(st("s", "site@x.test", { role: "ADMIN" })).toMatchObject({ level: "admin", source: "site", onRoster: false, powers: NO_POWERS });
  });

  it("game admins come from the row only and must be verified", () => {
    expect(st("g", "g@x.test", {}, { ban: true })).toMatchObject({ level: "game", source: "panel", onRoster: true, siteAdmin: false, powers: { ...NO_POWERS, ban: true } });
    expect(st("g", "g@x.test", { verified: false }, { ban: true })).toMatchObject({ level: "none", onRoster: false, powers: NO_POWERS });
    expect(st("p", "p@x.test")).toMatchObject({ level: "none", onRoster: false });
  });
});

describe("permission matrix", () => {
  const owner = st("o", "boss@x.test", { role: "ADMIN" });
  const envAdmin = st("e", "ops@x.test", { role: "ADMIN" });
  const siteAdmin = st("s", "site@x.test", { role: "ADMIN" });
  const kicker = st("k", "k@x.test", {}, { kick: true });
  const banner = st("b", "b@x.test", {}, { ban: true });
  const fresh = st("f", "f@x.test", {}, { ...NO_POWERS });
  const player = st("p", "p@x.test");
  const unverified = st("u", "u@x.test", { verified: false });
  const all: Standing[] = [owner, envAdmin, siteAdmin, kicker, banner, fresh, player];

  it("panel access: owner, site admins, game admins", () => {
    expect(all.map(canAccessPanel)).toEqual([true, true, true, true, true, true, false]);
    expect(canSeeEmails(owner) && canSeeEmails(siteAdmin) && canSeeEmails(envAdmin)).toBe(true);
    expect(canSeeEmails(kicker) || canSeeEmails(player)).toBe(false);
  });

  it("promote: owner or admin, a verified non-admin player, never self", () => {
    expect(canPromote(owner, player)).toBe(true);
    expect(canPromote(envAdmin, player)).toBe(true);
    expect(canPromote(siteAdmin, player)).toBe(true);
    expect(canPromote(kicker, player)).toBe(true); // any admin, game admins included
    expect(canPromote(player, st("q", "q@x.test"))).toBe(false);
    expect(canPromote(owner, unverified)).toBe(false);
    for (const t of [owner, envAdmin, siteAdmin, kicker, fresh]) expect(canPromote(owner, t), t.id).toBe(false);
  });

  it("demote and powers: owner only, never the owner, self or other roles' actors", () => {
    expect(canDemote(owner, kicker)).toBe(true);
    expect(canDemote(owner, envAdmin)).toBe(false); // env admins come from env, not the table
    expect(canDemote(owner, owner)).toBe(false);
    for (const a of [envAdmin, siteAdmin, kicker, banner, player]) {
      expect(canDemote(a, kicker), a.id).toBe(false);
      expect(canSetPowers(a, kicker), a.id).toBe(false);
    }
    expect(canSetPowers(owner, kicker)).toBe(true);
    expect(canSetPowers(owner, envAdmin)).toBe(true);
    expect(canSetPowers(owner, owner)).toBe(false);
    expect(canSetPowers(owner, player)).toBe(false);
  });

  it("kick and ban need the power; the owner is untouchable; only the owner reaches admins", () => {
    expect(canKick(kicker, player)).toBe(true);
    expect(canKick(banner, player)).toBe(false);
    expect(canBan(banner, player)).toBe(true);
    expect(canBan(kicker, player)).toBe(false);
    expect(canBan(owner, player)).toBe(true);
    for (const a of [envAdmin, kicker, banner]) {
      expect(canBan(a, owner), a.id).toBe(false);
      expect(canKick(a, owner), a.id).toBe(false);
      expect(canBan(a, a), a.id).toBe(false);
    }
    expect(canBan(envAdmin, kicker)).toBe(false);
    expect(canBan(envAdmin, siteAdmin)).toBe(false);
    expect(canBan(owner, envAdmin)).toBe(true);
    expect(canBan(owner, kicker)).toBe(true);
    expect(canBan(owner, owner)).toBe(false);
  });
});

describe("emails and names", () => {
  it("masks to first letter + domain", () => {
    expect(maskEmail("nick@example.com")).toBe("n***@example.com");
    expect(maskEmail("weird")).toBe("***");
  });
  it("displayName is Player- + 8 hex, stable, never contains the id", () => {
    expect(displayName("abc")).toMatch(/^Player-[0-9a-f]{8}$/);
    expect(displayName("abc")).toBe(displayName("abc"));
    expect(displayName("abc")).not.toBe(displayName("abd"));
  });
});

describe("bans", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const t = (ms: number) => new Date(now.getTime() + ms);
  it("is active when not revoked and not expired", () => {
    expect(banActive({ revokedAt: null, expiresAt: null }, now)).toBe(true);
    expect(banActive({ revokedAt: null, expiresAt: t(1) }, now)).toBe(true);
    expect(banActive({ revokedAt: null, expiresAt: t(0) }, now)).toBe(false);
    expect(banActive({ revokedAt: null, expiresAt: t(-1) }, now)).toBe(false);
    expect(banActive({ revokedAt: now, expiresAt: null }, now)).toBe(false);
  });
  it("combines overlapping bans: permanent wins, else the latest end", () => {
    expect(banExpiry([{ expiresAt: t(5) }, { expiresAt: null }])).toBeNull();
    expect(banExpiry([{ expiresAt: t(5) }, { expiresAt: t(9) }])).toEqual(t(9));
  });
  it("durations", () => {
    expect(banExpiryFromMinutes(null, now)).toBeNull();
    expect(banExpiryFromMinutes(90, now)).toEqual(t(90 * 60_000));
  });
  it("server write schemas are strict and bounded", () => {
    const ok = { accountId: "a", byAccountId: "b", reason: "x", durationMinutes: 60 };
    expect(ServerBanRequest.safeParse(ok).success).toBe(true);
    expect(ServerBanRequest.safeParse({ ...ok, reason: null, durationMinutes: null }).success).toBe(true);
    for (const patch of [{ durationMinutes: 0 }, { durationMinutes: 525_601 }, { durationMinutes: 1.5 }, { reason: "" }, { reason: "x".repeat(201) }, { extra: 1 }, { accountId: undefined }, { reason: undefined }, { durationMinutes: undefined }]) {
      expect(ServerBanRequest.safeParse({ ...ok, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
    expect(ServerBanRequest.safeParse({ ...ok, durationMinutes: 525_600 }).success).toBe(true);
    expect(AckRequest.safeParse({ result: "done" }).success).toBe(true);
    for (const bad of [{ result: "ok" }, {}, { result: "done", x: 1 }]) expect(AckRequest.safeParse(bad).success).toBe(false);
  });
});
