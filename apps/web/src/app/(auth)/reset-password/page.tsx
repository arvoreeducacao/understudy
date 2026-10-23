import Link from "next/link";
import { ResetPasswordForm } from "@/components/ResetPasswordForm";
import { messages } from "@/lib/messages";
import { resetLinkOwner } from "@/lib/reset-link";

export const metadata = { referrer: "no-referrer" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const t = messages.resetPassword;
  if (!(await resetLinkOwner(token))) {
    return (
      <div className="card w-full p-6 flex flex-col gap-3 text-center">
        <h1 className="m-0 text-[17px] font-semibold">{t.expiredTitle}</h1>
        <p className="m-0 text-ash text-[13px]">{t.expired}</p>
        <Link href="/sign-in" className="btn sec">
          {t.signIn}
        </Link>
      </div>
    );
  }
  return <ResetPasswordForm token={token} />;
}
