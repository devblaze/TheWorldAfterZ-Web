"use server";

import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";
import { safeLauncherNext } from "@/lib/launcher/validate";

export async function loginAction(form: FormData) {
  const next = safeLauncherNext(form.get("next"));
  try {
    await signIn("credentials", {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      redirectTo: next ?? "/account",
    });
  } catch (e) {
    if (e instanceof AuthError) {
      const q = new URLSearchParams({ error: "1" });
      if (next) q.set("next", next);
      redirect(`/login?${q.toString()}`);
    }
    throw e; // the success redirect is thrown too
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: "/" });
}
