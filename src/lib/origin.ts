/** Same rule as the API origin check: AUTH_URL's origin, or the request origin when AUTH_URL is unset. */
export function originAllowed(headers: Headers, fallbackOrigin: string): boolean {
  const expected = process.env.AUTH_URL ? new URL(process.env.AUTH_URL).origin : fallbackOrigin;
  const origin = headers.get("origin");
  // Some referrer policies make browsers send "Origin: null"; Sec-Fetch-Site can't be set by pages, so trust it then.
  const sameSite = origin === "null" && headers.get("sec-fetch-site") === "same-origin";
  return origin === expected || sameSite;
}
