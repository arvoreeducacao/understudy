"use client";

import Link from "next/link";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { messages } from "@/lib/messages";
import { Input } from "@/components/ui/controls";

export function AuthForm({ domains, google, googleOnly, forgot }: { domains: string[]; google: boolean; googleOnly: string[]; forgot: boolean }) {
  const t = messages.auth;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<"totp" | "backup" | null>(null);
  const selfSignUp = domains.some((domain) => !googleOnly.includes(domain));

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.email({
      email: String(form.get("email") ?? "").trim(),
      password: String(form.get("password") ?? ""),
    });
    setBusy(false);
    if (result.error) {
      setError(result.error.status === 403 && googleOnly.length > 0 ? t.googleOnly : t.failed);
      return;
    }
    if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) {
      setChallenge("totp");
      return;
    }
    window.location.href = "/";
  }

  async function verify(form: FormData) {
    setBusy(true);
    setError(null);
    const code = String(form.get("code") ?? "").replace(/\s/g, "");
    const result =
      challenge === "backup"
        ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice: true })
        : await authClient.twoFactor.verifyTotp({ code, trustDevice: true });
    setBusy(false);
    if (result.error) {
      setError(messages.twoFactor.wrongCode);
      return;
    }
    window.location.href = "/";
  }

  if (challenge) {
    const tf = messages.twoFactor;
    return (
      <form key={challenge} action={verify} className="card w-full p-6 flex flex-col gap-3">
        <h1 className="m-0 text-[17px] font-semibold">{tf.challengeTitle}</h1>
        <p className="m-0 text-ash text-[13px]">{challenge === "backup" ? tf.backupPrompt : tf.challengeBody}</p>
        <div className="fld">
          <label htmlFor="code">{challenge === "backup" ? tf.backupCode : tf.code}</label>
          <Input
            id="code"
            name="code"
            autoComplete="one-time-code"
            inputMode={challenge === "backup" ? "text" : "numeric"}
            required
            autoFocus
          />
        </div>
        {error && <div className="err" role="alert">{error}</div>}
        <button type="submit" className="btn pri w-full" disabled={busy}>
          {tf.verify}
        </button>
        <button
          type="button"
          className="text-[12.5px] text-ash hover:text-mist cursor-pointer bg-transparent border-0 p-0"
          onClick={() => {
            setError(null);
            setChallenge(challenge === "backup" ? "totp" : "backup");
          }}
        >
          {challenge === "backup" ? tf.useApp : tf.useBackup}
        </button>
      </form>
    );
  }

  return (
    <div className="card w-full p-6 flex flex-col gap-4">
      <h1 className="m-0 text-[17px] font-semibold">{t.signInTitle}</h1>
      {google && (
        <>
          <button
            type="button"
            className="btn sec w-full"
            onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/" })}
          >
            {t.google}
          </button>
          {googleOnly.length > 0 && <div className="text-smoke text-[11.5px] text-center -mt-2">{t.googleOnlyHint(googleOnly)}</div>}
          <div className="flex items-center gap-3 text-smoke text-[12px]">
            <span className="h-px flex-1 bg-graphite" />
            {t.or}
            <span className="h-px flex-1 bg-graphite" />
          </div>
        </>
      )}
      <form action={submit} className="flex flex-col gap-3">
        <div className="fld">
          <label htmlFor="email">{t.email}</label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
          {domains.length > 0 && <div className="text-smoke text-[11.5px] mt-1">{t.domainHint(domains)}</div>}
        </div>
        <div className="fld">
          <label htmlFor="password">{t.password}</label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
          {forgot && (
            <Link href="/forgot-password" className="text-[11.5px] text-smoke hover:text-mist mt-1 self-end">
              {messages.forgotPassword.link}
            </Link>
          )}
        </div>
        {error && <div className="err" role="alert">{error}</div>}
        <button type="submit" className="btn pri w-full" disabled={busy}>
          {t.signIn}
        </button>
      </form>
      {selfSignUp ? (
        <div className="text-[12.5px] text-ash text-center">
          {t.noAccount}{" "}
          <Link href="/sign-up" className="text-mist">
            {t.createOne}
          </Link>
        </div>
      ) : (
        <div className="text-[12.5px] text-ash text-center">{t.signUpClosed}</div>
      )}
    </div>
  );
}
