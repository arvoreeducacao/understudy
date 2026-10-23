"use client";

import Link from "next/link";
import { useActionState } from "react";
import { resetPasswordWithLink } from "@/app/actions/accounts";
import { messages } from "@/lib/messages";
import { Input } from "@/components/ui/controls";

export function ResetPasswordForm({ token }: { token: string }) {
  const t = messages.resetPassword;
  const [state, action, pending] = useActionState(resetPasswordWithLink, null);
  if (state?.done) {
    return (
      <div className="card w-full p-6 flex flex-col gap-3 text-center">
        <h1 className="m-0 text-[17px] font-semibold">{t.doneTitle}</h1>
        <p className="m-0 text-ash text-[13px]">{t.doneBody}</p>
        <Link href="/sign-in" className="btn pri">
          {t.signIn}
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="card w-full p-6 flex flex-col gap-3">
      <h1 className="m-0 text-[17px] font-semibold">{t.title}</h1>
      <p className="m-0 text-ash text-[13px]">{t.body}</p>
      <input type="hidden" name="token" value={token} />
      <div className="fld">
        <label htmlFor="newPassword">{messages.auth.newPassword}</label>
        <Input id="newPassword" name="newPassword" type="password" minLength={8} autoComplete="new-password" required autoFocus />
      </div>
      {state?.error && <div className="err" role="alert">{state.error}</div>}
      <button type="submit" className="btn pri w-full" disabled={pending}>
        {t.submit}
      </button>
    </form>
  );
}
