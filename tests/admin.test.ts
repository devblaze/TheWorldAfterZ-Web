import { describe, expect, it } from "vitest";
import { isAdminEmail } from "../src/lib/admin";

describe("isAdminEmail", () => {
  it("matches case-insensitively and trims", () => {
    expect(isAdminEmail("Nick@Example.com", " a@b.c , nick@example.com ")).toBe(true);
  });
  it("rejects when unset or not listed", () => {
    expect(isAdminEmail("nick@example.com", undefined)).toBe(false);
    expect(isAdminEmail("x@example.com", "nick@example.com")).toBe(false);
  });
});
