import Link from "next/link";
import { button, Card } from "@/components/ui";
import { readManifest } from "@/lib/manifest";
import { activeRedemption, requireUserPage } from "@/lib/session";

export default async function Download() {
  const user = await requireUserPage();
  if (!(await activeRedemption(user.id))) {
    return (
      <Card title="Download">
        <p>You need an active access key first. <Link className="underline" href="/redeem">Redeem one</Link>.</p>
      </Card>
    );
  }
  const m = await readManifest();
  return (
    <Card title="Download">
      {m ? (
        <div className="space-y-4 text-sm">
          <p>Launcher <strong>{m.version}</strong> ({(m.size / 1048576).toFixed(1)} MB)</p>
          <p className="break-all text-stone-400">SHA-256: <code>{m.sha256}</code></p>
          {/* Plain link: the API route 302s to a short-lived signed file URL. */}
          <a className={button} href="/api/download">Download launcher</a>
        </div>
      ) : (
        <p>The launcher is not available yet. Check back soon.</p>
      )}
    </Card>
  );
}
