import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { currentUser } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "TheWorldAfterZ",
  description: "Survive what comes after. Player portal for TheWorldAfterZ.",
};

// Reading the session makes every page dynamic, which the per-request CSP nonce requires.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  const link = "hover:text-amber-500";
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <header className="border-b border-stone-800 bg-stone-950/80">
          <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-3 text-sm uppercase tracking-wide">
            <Link href="/" className="mr-auto text-lg font-black tracking-widest text-amber-600">
              TheWorldAfter<span className="text-red-600">Z</span>
            </Link>
            {user ? (
              <>
                <Link className={link} href="/account">Account</Link>
                <Link className={link} href="/redeem">Redeem</Link>
                <Link className={link} href="/download">Download</Link>
                {user.role === "ADMIN" && (
                  <>
                    <Link className={link} href="/admin/keys">Keys</Link>
                    <Link className={link} href="/admin/users">Users</Link>
                  </>
                )}
                <Link className={link} href="/logout">Logout</Link>
              </>
            ) : (
              <>
                <Link className={link} href="/login">Login</Link>
                <Link className={link} href="/register">Register</Link>
              </>
            )}
          </nav>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">{children}</main>
        <footer className="border-t border-stone-800 py-4 text-center text-xs text-stone-600">
          TheWorldAfterZ. Stay quiet, stay alive.
        </footer>
      </body>
    </html>
  );
}
