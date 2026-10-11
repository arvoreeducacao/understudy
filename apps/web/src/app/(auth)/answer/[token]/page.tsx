import type { Metadata } from "next";
import Link from "next/link";
import { answerFromEmail } from "@/app/actions/approval-link";
import { Textarea } from "@/components/ui/controls";
import { messages } from "@/lib/messages";
import { approvalForLink } from "@/server/channels/approval-answer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function AnswerPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string }> }) {
  const { token } = await params;
  const { done } = await searchParams;
  const t = messages.channels;
  const approval = await approvalForLink(token);
  if (!approval) {
    return (
      <div className="card w-full p-6 flex flex-col gap-3 text-center">
        <p className="m-0 text-ash text-[13px]">{t.answerMissing}</p>
        <Link href="/waiting" className="btn sec">
          {t.answerOpenPanel}
        </Link>
      </div>
    );
  }
  const closed = approval.status !== "pending";
  const statusLabel = messages.approvals.status[approval.status] ?? approval.status;
  return (
    <div className="card w-full p-6 flex flex-col gap-4">
      <h1 className="m-0 text-[17px] font-semibold">{closed ? t.answerAsked(approval.agentName) : t.answerTitle(approval.agentName)}</h1>
      <p className="m-0 text-[14px] whitespace-pre-wrap break-words">{approval.summary}</p>
      {approval.fields.length > 0 && (
        <dl className="m-0 flex flex-col gap-2">
          {approval.fields.map((field, index) => (
            <div key={index} className="flex flex-col gap-0.5">
              <dt className="fld-label">{field.label}</dt>
              <dd className="m-0 text-[13px] whitespace-pre-wrap break-words max-h-48 overflow-auto">{field.value.trim() || messages.approvals.emptyValue}</dd>
            </div>
          ))}
        </dl>
      )}
      {done === "approved" || done === "denied" ? (
        <p className="m-0 text-[13px] text-green" role="status">
          {t.answerDone(done === "approved")}
        </p>
      ) : closed ? (
        <p className="m-0 text-[13px] text-ash" role="status">
          {t.answerClosed(statusLabel)}
        </p>
      ) : (
        <form action={answerFromEmail} className="flex flex-col gap-3">
          <input type="hidden" name="token" value={token} />
          <div className="fld">
            <label htmlFor="answer-note">{t.answerNote}</label>
            <Textarea id="answer-note" name="note" maxLength={2000} rows={2} />
          </div>
          <div className="flex gap-2">
            <button type="submit" name="decision" value="approve" className="btn pri flex-1">
              {t.answerApprove}
            </button>
            <button type="submit" name="decision" value="deny" className="btn sec flex-1">
              {t.answerDeny}
            </button>
          </div>
        </form>
      )}
      <Link href="/waiting" className="text-[12.5px] text-ash underline self-center">
        {t.answerOpenPanel}
      </Link>
    </div>
  );
}
