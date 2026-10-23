"use client";

import { Check, ListPlus, LoaderCircle, PencilLine, ShieldAlert, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { answerProposal, type ProposalChoice } from "@/app/actions/proposals";
import { messages } from "@/lib/messages";
import { describeSchedule } from "@/lib/schedule";
import type { ProposalView } from "@/server/hub-types";

const VISIBLE_STEPS = 6;

export function ProposalCard({ proposal, canAnswer, hint }: { proposal: ProposalView; canAnswer: boolean; hint?: string }) {
  const t = messages.proposals;
  const router = useRouter();
  const [busy, setBusy] = useState<ProposalChoice | null>(null);
  const [answered, setAnswered] = useState<ProposalView | null>(null);
  const [allSteps, setAllSteps] = useState(false);
  const view = answered && answered.status !== "pending" && proposal.status === "pending" ? answered : proposal;
  const { recipe } = view;
  const steps = allSteps ? recipe.steps : recipe.steps.slice(0, VISIBLE_STEPS);
  const hidden = recipe.steps.length - steps.length;
  const pending = view.status === "pending";

  async function choose(choice: ProposalChoice) {
    setBusy(choice);
    try {
      const result = await answerProposal(view.id, choice);
      if (result.ok) {
        setAnswered(result.proposal);
        if (result.redirectTo) router.push(result.redirectTo);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={`cx-approval cx-proposal ${pending ? "" : "is-answered"}`} aria-label={t.title}>
      <header>
        <span className="cx-approval-icon cx-proposal-icon">
          <ListPlus size={15} aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="cx-approval-title">{t.title}</div>
          <div className="cx-approval-summary">{view.reason}</div>
        </div>
      </header>
      <div className="cx-proposal-recipe">
        <div className="cx-proposal-name">{recipe.title}</div>
        <div className="cx-proposal-trigger">{recipe.trigger}</div>
        <ol className="cx-proposal-steps" aria-label={t.steps}>
          {steps.map((step) => (
            <li key={step.id}>
              <span>{step.text}</span>
              {step.mode === "ask" && (
                <span className="cx-proposal-ask">
                  <ShieldAlert size={11} aria-hidden />
                  {t.askFirst}
                </span>
              )}
            </li>
          ))}
        </ol>
        {hidden > 0 && (
          <button type="button" className="cx-proposal-more" onClick={() => setAllSteps(true)}>
            {t.moreSteps(hidden)}
          </button>
        )}
        <dl className="cx-proposal-meta">
          <div>
            <dt>{t.when}</dt>
            <dd>{describeSchedule(view.cron)}</dd>
          </div>
          {recipe.questions.length > 0 && (
            <div>
              <dt>{t.inputs}</dt>
              <dd>{recipe.questions.map((question) => question.text).join(" · ")}</dd>
            </div>
          )}
        </dl>
      </div>
      {pending && <p className="cx-proposal-note">{!canAnswer && hint ? hint : t.firstRuns(recipe.askFirstRuns)}</p>}
      {pending && canAnswer && (
        <div className="cx-approval-actions cx-proposal-actions">
          <button className="btn sm sec" disabled={busy !== null} onClick={() => choose("dismiss")}>
            {busy === "dismiss" ? <LoaderCircle size={14} className="cx-spin" aria-hidden /> : <X size={14} aria-hidden />}
            {t.dismiss}
          </button>
          <button className="btn sm sec" disabled={busy !== null} onClick={() => choose("edit")}>
            {busy === "edit" ? <LoaderCircle size={14} className="cx-spin" aria-hidden /> : <PencilLine size={14} aria-hidden />}
            {t.saveAndEdit}
          </button>
          <button className="btn sm pri" disabled={busy !== null} onClick={() => choose("save")}>
            {busy === "save" ? <LoaderCircle size={14} className="cx-spin" aria-hidden /> : <Check size={14} aria-hidden />}
            {t.save}
          </button>
        </div>
      )}
      {!pending && (
        <div className="cx-proposal-outcome">
          <span className={`pill ${view.status === "saved" ? "g" : ""} inline-flex items-center gap-1`}>
            {view.status === "saved" ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
            {view.status === "saved" ? t.saved : t.dismissed}
          </span>
          {view.recipeId && (
            <Link href={`/agents/${view.agentId}/recipes/${view.recipeId}`} className="cx-proposal-link">
              {t.openTask}
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
