"use client";

import Link from "next/link";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { messages } from "@/lib/messages";
import { Input } from "@/components/ui/controls";

export function ForgotPasswordForm() {
  const t = messages.forgotPassword;
  const [state, setState] = useState<"idle" | "busy" | "sent" | "google">("idle");

  async function submit(form: FormData) {
    setState("busy");
    const result = await authClient.requestPasswordReset({ email: String(form.get("email") ?? "").trim() });
    setState(result.error?.status === 403 ? "google" : "sent");
  }

  if (state === "sent") {
    return (
      <div className="card w-full p-6 flex flex-col gap-3 text-center">
        <h1 className="m-0 text-[17px] font-semibold">{t.sentTitle}</h1>
        <p className="m-0 text-ash text-[13px]">{t.sentBody}</p>
        <Link href="/sign-in" className="btn sec">
          {t.back}
        </Link>
      </div>
    );
  }

  return (
    <form action={submit} className="card w-full p-6 flex flex-col gap-3">
      <h1 className="m-0 text-[17px] font-semibold">{t.title}</h1>
      <p className="m-0 text-ash text-[13px]">{t.body}</p>
      <div className="fld">
        <label htmlFor="email">{messages.auth.email}</label>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      </div>
      {state === "google" && <div className="err" role="alert">{messages.auth.googleOnly}</div>}
      <button type="submit" className="btn pri w-full" disabled={state === "busy"}>
        {t.submit}
      </button>
      <Link href="/sign-in" className="text-[12.5px] text-ash text-center">
        {t.back}
      </Link>
    </form>
  );
}
