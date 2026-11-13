import { describe, expect, it } from "vitest";
import { launcherRole } from "../src/lib/launcher/role";

const nick = { email: "Nick@Example.com", emailVerifiedAt: new Date(), role: "ADMIN" };

describe("launcherRole (fails closed)", () => {
  it("is admin only for a verified ADMIN listed in ADMIN_EMAILS", () => {
    expect(launcherRole(nick, "nick@example.com")).toBe("admin");
    expect(launcherRole(nick, " other@x.y , NICK@example.com ")).toBe("admin");
  });
  it("is player on missing, empty or non-matching config", () => {
    for (const env of [undefined, "", " ,, ", "other@example.com", "nick@example.co", "nick@example.com.evil"]) {
      expect(launcherRole(nick, env)).toBe("player");
    }
  });
  it("is player for an unverified account or any non-ADMIN role even when listed", () => {
    expect(launcherRole({ ...nick, emailVerifiedAt: null }, "nick@example.com")).toBe("player");
    for (const role of ["PLAYER", "admin", "OWNER", ""]) expect(launcherRole({ ...nick, role }, "nick@example.com")).toBe("player");
  });
});
