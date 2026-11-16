import { describe, expect, it } from "vitest";
import { canonicalJson, etagFor, ifNoneMatchHits } from "../src/lib/etag";

describe("etag", () => {
  it("is a quoted 32-hex strong tag, independent of key order, sensitive to values and array order", () => {
    const e = etagFor({ version: 1, admins: [{ a: 1, b: 2 }] });
    expect(e).toMatch(/^"[0-9a-f]{32}"$/);
    expect(etagFor({ admins: [{ b: 2, a: 1 }], version: 1 })).toBe(e);
    expect(etagFor({ version: 2, admins: [{ a: 1, b: 2 }] })).not.toBe(e);
    expect(etagFor([1, 2])).not.toBe(etagFor([2, 1]));
    expect(canonicalJson({ b: null, a: [1, "x"] })).toBe('{"a":[1,"x"],"b":null}');
  });

  it("matches If-None-Match per RFC 9110 weak comparison", () => {
    const e = etagFor({ v: 1 });
    expect(ifNoneMatchHits(e, e)).toBe(true);
    expect(ifNoneMatchHits(`W/${e}`, e)).toBe(true);
    expect(ifNoneMatchHits(`"other", ${e}`, e)).toBe(true);
    expect(ifNoneMatchHits("*", e)).toBe(true);
    expect(ifNoneMatchHits('"other"', e)).toBe(false);
    expect(ifNoneMatchHits(null, e)).toBe(false);
    expect(ifNoneMatchHits("", e)).toBe(false);
  });
});
