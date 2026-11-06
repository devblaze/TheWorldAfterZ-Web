import { describe, expect, it } from "vitest";
import { DOWNLOAD_TTL_S, generateKey, KEY_RE, keyPrefix, normalizeKey, sha256, signDownload, verifyDownload } from "../src/lib/crypto";

describe("access keys", () => {
  it("generates TWAZ-XXXX-XXXX-XXXX from the Crockford alphabet", () => {
    const keys = new Set(Array.from({ length: 1000 }, generateKey));
    expect(keys.size).toBe(1000);
    for (const k of keys) {
      expect(k).toMatch(KEY_RE);
      expect(k).not.toMatch(/[ILOU]/);
    }
  });

  it("hashes deterministically and normalizes user input", () => {
    const k = generateKey();
    expect(sha256(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(k)).toBe(sha256(normalizeKey(` ${k.toLowerCase()} `)!));
    expect(normalizeKey("twaz-abco-1il0-zzzz")).toBe("TWAZ-ABC0-1110-ZZZZ");
    expect(normalizeKey("TWAZ-ABCD-EFGH")).toBeNull();
    expect(normalizeKey("TWAZ-ABCD-EFGH-UUUU")).toBeNull();
    expect(keyPrefix("TWAZ-AB12-CD34-EF56")).toBe("AB12");
  });
});

describe("signed download URLs", () => {
  const secret = "test-secret";
  const now = 1_700_000_000_000;

  it("verifies a fresh signature", () => {
    const { exp, sig } = signDownload("launcher.zip", secret, now);
    expect(exp).toBe(now / 1000 + DOWNLOAD_TTL_S);
    expect(verifyDownload(String(exp), sig, "launcher.zip", secret, now)).toBe(true);
  });

  it("rejects tampering, wrong secret, wrong file and expiry", () => {
    const { exp, sig } = signDownload("launcher.zip", secret, now);
    const flipped = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    expect(verifyDownload(String(exp), flipped, "launcher.zip", secret, now)).toBe(false);
    expect(verifyDownload(String(exp + 1), sig, "launcher.zip", secret, now)).toBe(false);
    expect(verifyDownload(String(exp), sig, "launcher.zip", "other", now)).toBe(false);
    expect(verifyDownload(String(exp), sig, "other.zip", secret, now)).toBe(false);
    expect(verifyDownload(String(exp), sig, "launcher.zip", secret, now + (DOWNLOAD_TTL_S + 1) * 1000)).toBe(false);
    expect(verifyDownload(null, sig, "launcher.zip", secret, now)).toBe(false);
    expect(verifyDownload("abc", "zz", "launcher.zip", secret, now)).toBe(false);
  });
});
