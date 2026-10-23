"use client";

import QRCode from "qrcode";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { messages } from "@/lib/messages";
import { Input } from "@/components/ui/controls";
import { SignOut } from "@/components/SignOut";

type Enrollment = { qr: string; secret: string; backupCodes: string[] };

export function TwoFactorSetup({ email, needsPassword }: { email: string; needsPassword: boolean }) {
  const t = messages.twoFactor;
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(form: FormData) {
    setBusy(true);
    setError(null);
    const password = needsPassword ? String(form.get("password") ?? "") : undefined;
    const result = await authClient.twoFactor.enable(password === undefined ? {} : { password });
    if (result.error || !result.data || !("totpURI" in result.data) || !result.data.totpURI) {
      setBusy(false);
      setError(needsPassword ? t.wrongPassword : t.startFailed);
      return;
    }
    const uri = result.data.totpURI;
    setEnrollment({
      qr: await QRCode.toDataURL(uri, { margin: 1, width: 192 }),
      secret: new URL(uri).searchParams.get("secret") ?? "",
      backupCodes: result.data.backupCodes ?? [],
    });
    setBusy(false);
  }

  async function confirm(form: FormData) {
    setBusy(true);
    setError(null);
    const result = await authClient.twoFactor.verifyTotp({ code: String(form.get("code") ?? "").replace(/\s/g, "") });
    if (result.error) {
      setBusy(false);
      setError(t.wrongCode);
      return;
    }
    window.location.href = "/";
  }

  if (!enrollment) {
    return (
      <form action={start} className="card w-full p-6 flex flex-col gap-3">
        <h1 className="m-0 text-[17px] font-semibold">{t.title}</h1>
        <p className="m-0 text-ash text-[13px]">{t.body}</p>
        <div className="text-smoke text-[12.5px]">{email}</div>
        {needsPassword && (
          <div className="fld">
            <label htmlFor="password">{t.password}</label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
        )}
        {error && <div className="err" role="alert">{error}</div>}
        <button type="submit" className="btn pri w-full" disabled={busy}>
          {t.start}
        </button>
        <div className="text-center">
          <SignOut />
        </div>
      </form>
    );
  }

  return (
    <form action={confirm} className="card w-full p-6 flex flex-col gap-3">
      <h1 className="m-0 text-[17px] font-semibold">{t.scanTitle}</h1>
      <p className="m-0 text-ash text-[13px]">{t.scanBody}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={enrollment.qr} alt={t.qrAlt} width={192} height={192} className="self-center rounded-[10px] bg-white" />
      <div className="text-smoke text-[12px] text-center">
        {t.manual} <code className="select-all break-all">{enrollment.secret}</code>
      </div>
      <div className="fld">
        <label>{t.backupTitle}</label>
        <p className="m-0 text-ash text-[12.5px]">{t.backupBody}</p>
        <pre className="m-0 mt-1 p-3 rounded-[10px] bg-graphite text-[12.5px] leading-6 select-all whitespace-pre-wrap">{enrollment.backupCodes.join("\n")}</pre>
      </div>
      <div className="fld">
        <label htmlFor="code">{t.code}</label>
        <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required autoFocus />
      </div>
      {error && <div className="err" role="alert">{error}</div>}
      <button type="submit" className="btn pri w-full" disabled={busy}>
        {t.confirm}
      </button>
    </form>
  );
}
