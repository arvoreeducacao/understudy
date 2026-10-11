"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { AgentState } from "@understudy/protocol";
import { AgentFigure } from "@/components/AgentFigure";
import { Textarea } from "@/components/ui/controls";
import type { Look } from "@/lib/look";
import { messages } from "@/lib/messages";
import { agentTabPath } from "@/lib/workspace-tabs";

const t = messages.teach;

export function DescribeTaskForm({
  online,
  brainReady,
  processing,
  onSubmit,
  roomy = false,
}: {
  online: boolean;
  brainReady: boolean;
  processing: boolean;
  onSubmit: (text: string) => boolean;
  roomy?: boolean;
}) {
  const [description, setDescription] = useState("");
  return (
    <form
      className={roomy ? "flex flex-col gap-3" : "flex flex-col gap-2 mt-2 border-t border-graphite pt-3"}
      onSubmit={(e) => {
        e.preventDefault();
        const text = description.trim();
        if (text && onSubmit(text)) setDescription("");
      }}
    >
      {!roomy && <div className="text-[13px] font-semibold">{t.describeTitle}</div>}
      <div className="text-[12px] text-smoke">{t.describeHint}</div>
      <Textarea
        size={roomy ? undefined : "sm"}
        aria-label={roomy ? t.describeOnlyTitle : t.describeTitle}
        className={roomy ? "resize-none [field-sizing:content] !min-h-[180px]" : "resize-none [field-sizing:content] !min-h-[120px]"}
        placeholder={t.describePlaceholder}
        value={description}
        disabled={processing || !online}
        onChange={(e) => setDescription(e.target.value)}
      />
      <button type="submit" className={roomy ? "btn pri" : "btn sec sm self-start"} disabled={processing || !online || !brainReady || !description.trim()}>
        {t.describeSubmit}
      </button>
    </form>
  );
}

export function TeachByWords({
  agent,
  face,
  online,
  brainReady,
  processing,
  failure,
  onSubmit,
}: {
  agent: { id: string; name: string; look: Look };
  face: AgentState;
  online: boolean;
  brainReady: boolean;
  processing: boolean;
  failure: string | null;
  onSubmit: (text: string) => boolean;
}) {
  return (
    <div className="sky-page min-h-dvh px-4 pb-6 pt-[max(16px,env(safe-area-inset-top))]">
      <div className="max-w-[560px] mx-auto flex flex-col gap-5">
        <Link href={`/agents/${agent.id}`} aria-label={messages.common.back} className="cx-back self-start">
          <ArrowLeft size={18} aria-hidden />
        </Link>
        <div className="flex items-center gap-4">
          <AgentFigure state={face} size={56} look={agent.look} />
          <div className="min-w-0">
            <h1 className="m-0 text-[22px] font-semibold tracking-[-0.03em]">{t.phoneTitle(agent.name)}</h1>
            <p className="m-0 text-smoke text-[13px]">{t.phoneHint}</p>
          </div>
        </div>
        <section className="card p-4 flex flex-col gap-3" aria-live="polite">
          <h2 className="m-0 text-[16px] font-semibold tracking-[-0.02em]">{t.describeOnlyTitle}</h2>
          {processing && (
            <span className="pill s self-start">
              <span className="dot" />
              {t.understanding}
            </span>
          )}
          {failure && <div className="err">{failure}</div>}
          {online && !brainReady && (
            <div className="err">
              {t.noBrain}{" "}
              <Link href={agentTabPath(agent.id, "settings")} className="underline">
                {t.connectBrain}
              </Link>
            </div>
          )}
          {!online && <div className="text-smoke text-[12.5px]">{messages.live.computerOffline}</div>}
          <DescribeTaskForm roomy online={online} brainReady={brainReady} processing={processing} onSubmit={onSubmit} />
        </section>
      </div>
    </div>
  );
}
