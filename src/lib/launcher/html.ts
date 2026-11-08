function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function shell(title: string, inner: string, nonce: string): string {
  const nonceAttr = nonce ? ` nonce="${esc(nonce)}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · TheWorldAfterZ</title>
<style${nonceAttr}>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; background: #0c0a09; color: #e7e5e4; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 28rem; margin: 4rem auto; padding: 1.5rem; border: 1px solid #292524; border-radius: 0.5rem; background: rgb(28 25 23 / 0.85); }
  h1 { margin: 0 0 1rem; font-size: 1.25rem; letter-spacing: 0.08em; text-transform: uppercase; color: #f59e0b; }
  p { color: #d6d3d1; }
  a { color: #fbbf24; }
  .row { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.25rem; }
  button { font: inherit; cursor: pointer; border-radius: 0.25rem; padding: 0.55rem 1rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
  button.yes { background: #b45309; color: #1c1917; border: 0; }
  button.no { background: transparent; color: #e7e5e4; border: 1px solid #57534e; }
</style>
</head>
<body>
<main>
${inner}
</main>
</body>
</html>`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

export function consentPage(opts: {
  email: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  nonce: string;
}): string {
  const inner = `<h1>Launcher sign-in</h1>
<p>Allow TheWorldAfterZ Launcher to sign in as ${esc(opts.email)}?</p>
<form method="post" action="/launcher/authorize">
${hidden("userId", opts.userId)}
${hidden("client_id", opts.clientId)}
${hidden("redirect_uri", opts.redirectUri)}
${hidden("response_type", "code")}
${hidden("state", opts.state)}
${hidden("code_challenge", opts.codeChallenge)}
${hidden("code_challenge_method", "S256")}
<div class="row">
<button class="yes" type="submit" name="decision" value="approve">Approve</button>
<button class="no" type="submit" name="decision" value="deny">Deny</button>
</div>
</form>
<p>Not you? <a href="/logout">Sign out</a></p>`;
  return shell("Allow the launcher", inner, opts.nonce);
}

export function messagePage(title: string, message: string, nonce: string): string {
  return shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`, nonce);
}
