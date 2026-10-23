"use client";

import { useState, useTransition } from "react";
import { createResetLink, resetTwoFactor, setUserStatus } from "@/app/actions/accounts";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Input } from "@/components/ui/controls";
import { messages } from "@/lib/messages";

const t = messages.admin;

export function UserActions({
  userId,
  name,
  status,
  self,
  googleOnly,
  twoFactorEnabled,
}: {
  userId: string;
  name: string;
  status: string;
  self: boolean;
  googleOnly: boolean;
  twoFactorEnabled: boolean;
}) {
  const [pending, start] = useTransition();
  const [link, setLink] = useState<{ url?: string; error?: string } | null>(null);
  if (self) return null;
  const approved = status === "approved";
  return (
    <div className="flex gap-2 flex-wrap justify-end">
      {status !== "approved" && (
        <button className="btn ok sm" disabled={pending} onClick={() => start(() => setUserStatus(userId, "approved"))}>
          {status === "rejected" ? t.restore : t.approve}
        </button>
      )}
      {status === "pending" && (
        <button className="btn sec sm" disabled={pending} onClick={() => start(() => setUserStatus(userId, "rejected"))}>
          {t.reject}
        </button>
      )}
      {approved && !googleOnly && (
        <button
          className="btn sec sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await createResetLink(userId);
              if (result.url) await navigator.clipboard.writeText(result.url).catch(() => undefined);
              setLink(result);
            })
          }
        >
          {link?.url ? t.resetLinkCopied : t.resetLink}
        </button>
      )}
      {approved && twoFactorEnabled && (
        <ConfirmButton label={t.resetTwoFactor} question={t.resetTwoFactorConfirm(name)} disabled={pending} onConfirm={() => start(() => resetTwoFactor(userId))} />
      )}
      {approved && (
        <ConfirmButton label={t.revoke} question={t.revokeConfirm(name)} disabled={pending} onConfirm={() => start(() => setUserStatus(userId, "rejected"))} />
      )}
      {link?.url && (
        <div className="basis-full flex flex-col gap-1 text-left">
          <Input size="sm" className="w-full" readOnly value={link.url} aria-label={t.resetLink} onFocus={(e) => e.currentTarget.select()} />
          <span className="text-smoke text-[11.5px]">{t.resetLinkHint}</span>
        </div>
      )}
      {link?.error && (
        <div className="basis-full err text-left" role="alert">
          {link.error}
        </div>
      )}
    </div>
  );
}
