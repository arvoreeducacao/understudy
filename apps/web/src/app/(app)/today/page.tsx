import Link from "next/link";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { AgentFigure } from "@/components/AgentFigure";
import { EmptyState } from "@/components/ui/EmptyState";
import { approvalScope, involvedAgentIds } from "@/lib/access";
import { getDb, schema } from "@/lib/db";
import { formatWhen } from "@/lib/format";
import { messages } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { FollowupList } from "@/components/followups/FollowupList";
import { pendingFollowups, toSummaries } from "@/server/followups";
import { brainName, loadOpenFailures, noticePath } from "@/server/run-alerts";
import { nextRunAt } from "@/server/scheduler";

export default async function TodayPage() {
  const user = await requireUser();
  const t = messages.today;
  const db = getDb();
  const [ids, answerable, owned] = await Promise.all([
    involvedAgentIds(user.id),
    approvalScope(user.id),
    involvedAgentIds(user.id, ["owner"]),
  ]);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const agents = ids.length ? await db.select().from(schema.agents).where(inArray(schema.agents.id, ids)) : [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  const runs = ids.length
    ? await db
        .select({ run: schema.runs, title: schema.recipes.recipe })
        .from(schema.runs)
        .leftJoin(schema.recipes, eq(schema.recipes.id, schema.runs.recipeId))
        .where(and(inArray(schema.runs.agentId, ids), gte(schema.runs.startedAt, since)))
        .orderBy(desc(schema.runs.startedAt))
    : [];
  const pending = await db
    .select()
    .from(schema.approvals)
    .where(and(answerable, eq(schema.approvals.status, "pending")))
    .orderBy(desc(schema.approvals.createdAt));
  const recipes = ids.length
    ? await db.select().from(schema.recipes).where(and(inArray(schema.recipes.agentId, ids), eq(schema.recipes.active, true)))
    : [];
  const upcoming = recipes
    .map((r) => ({ recipe: r, at: r.cron ? nextRunAt(r.cron, r.timezone) : null }))
    .filter((x): x is { recipe: typeof x.recipe; at: Date } => x.at !== null && x.at.getTime() - Date.now() < 24 * 60 * 60 * 1000)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const followups = toSummaries(await pendingFollowups(ids, 20, user.id), {
    format: formatWhen,
    canCancel: (agentId) => byId.get(agentId)?.ownerId === user.id,
    agentName: (agentId) => byId.get(agentId)?.name,
  });
  const failures = await loadOpenFailures(owned);
  const failing = new Set(failures.map((f) => f.latest.agent.id));
  const ok = runs.filter((r) => r.run.status === "ok");
  const failed = runs.filter((r) => r.run.status === "failed");
  const stuck = agents.filter((a) => a.ownerId === user.id && a.state === "stuck" && !failing.has(a.id));
  const waitingCount = pending.length + failures.length + stuck.length;
  const groups = new Map<string, { latest: (typeof runs)[number]; total: number; failed: number }>();
  for (const row of runs) {
    const key = row.run.recipeId ? `${row.run.agentId}:${row.run.recipeId}` : row.run.id;
    const group = groups.get(key);
    if (group) {
      group.total += 1;
      if (row.run.status === "failed") group.failed += 1;
    } else groups.set(key, { latest: row, total: 1, failed: row.run.status === "failed" ? 1 : 0 });
  }
  const quiet = runs.length === 0 && waitingCount === 0 && upcoming.length === 0 && followups.length === 0;

  return (
    <div className="page">
      <div className="top">
        <div>
          <h1>{t.title(user.name.split(" ")[0] ?? "")}</h1>
          <p>{quiet ? t.quiet : t.summary(ok.length, failed.length, waitingCount)}</p>
        </div>
      </div>
      {quiet ? (
        <div className="py-6">
          <EmptyState
            framed
            mood="happy"
            title={messages.empty.todayTitle}
            body={messages.empty.todayBody}
            action={agents.length ? { href: "/", label: messages.empty.todayAction, secondary: true } : { href: "/agents/new", label: messages.empty.agentsAction }}
          />
        </div>
      ) : (
      <div className="grid grid-cols-2 gap-5 py-6 max-[1000px]:grid-cols-1">
        <section className="card p-[18px] flex flex-col gap-2.5">
          <h2 className="m-0 text-[14px] font-semibold">{t.waiting}</h2>
          {waitingCount === 0 ? (
            <EmptyState size="sm" mood="happy" title={messages.empty.todayWaiting} />
          ) : (
            <>
            {failures.map(({ latest, streak, signedOut }) => (
              <Link
                key={latest.recipeId}
                href={noticePath({ agentId: latest.agent.id, runId: latest.runId, signedOut })}
                className="flex items-center gap-3 no-underline hover:text-mist text-[13px]"
              >
                <AgentFigure state="stuck" size={30} look={latest.agent.look as never} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2">{messages.runAlerts.failed(latest.agent.name, latest.task)}</span>
                  <span className="block text-smoke text-[12px] truncate">
                    {signedOut ? messages.runAlerts.signInAction(brainName(latest.agent.brain)) : (latest.summary ?? "")}
                  </span>
                </span>
                <span className="pill c whitespace-nowrap">{streak > 1 ? messages.runAlerts.waitingRepeated(streak) : messages.runAlerts.waitingFailed}</span>
              </Link>
            ))}
            {stuck.map((a) => (
              <Link key={a.id} href={`/agents/${a.id}`} className="flex items-center gap-3 no-underline hover:text-mist text-[13px]">
                <AgentFigure state="stuck" size={30} look={a.look} />
                <span className="min-w-0 flex-1 line-clamp-2">
                  <b className="font-medium">{a.name}</b> · {a.stateNote ?? t.needsHelp}
                </span>
                <span className="pill c whitespace-nowrap">{messages.states.stuck}</span>
              </Link>
            ))}
            {pending.map((a) => (
              <Link key={a.id} href="/waiting" className="flex items-center gap-3 no-underline hover:text-mist text-[13px]">
                <AgentFigure state="waiting_you" size={30} look={byId.get(a.agentId)?.look} />
                <span className="min-w-0 flex-1">
                  <b className="font-medium">{byId.get(a.agentId)?.name}</b> · {a.summary}
                </span>
                <span className="text-smoke text-[12px] whitespace-nowrap">{formatWhen(a.createdAt)}</span>
              </Link>
            ))}
            </>
          )}
        </section>
        <section className="card p-[18px] flex flex-col gap-2.5">
          <h2 className="m-0 text-[14px] font-semibold">{t.next}</h2>
          {upcoming.length === 0 ? (
            <EmptyState size="sm" mood="sleepy" title={messages.empty.todayNext} />
          ) : (
            upcoming.map(({ recipe, at }) => (
              <Link
                key={recipe.id}
                href={`/agents/${recipe.agentId}/recipes/${recipe.id}`}
                className="flex items-center gap-3 no-underline hover:text-mist text-[13px]"
              >
                <AgentFigure size={30} look={byId.get(recipe.agentId)?.look} live={false} />
                <span className="min-w-0 flex-1">
                  <b className="font-medium">{byId.get(recipe.agentId)?.name}</b>
                  {recipe.recipe.title !== byId.get(recipe.agentId)?.name ? ` · ${recipe.recipe.title}` : ""}
                </span>
                <span className="text-smoke text-[12px] whitespace-nowrap">{formatWhen(at)}</span>
              </Link>
            ))
          )}
        </section>
        {followups.length > 0 && (
          <section className="card p-[18px] flex flex-col gap-1 col-span-full" aria-labelledby="today-followups">
            <h2 id="today-followups" className="m-0 pb-1.5 text-[14px] font-semibold">
              {messages.followups.upcoming}
            </h2>
            <FollowupList items={followups} />
          </section>
        )}
        <section className="card p-[18px] flex flex-col gap-2.5 col-span-full">
          <h2 className="m-0 text-[14px] font-semibold">{t.done}</h2>
          {groups.size === 0 ? (
            <EmptyState size="sm" mood="calm" title={messages.empty.todayDone} />
          ) : (
            [...groups.values()].map(({ latest: { run, title }, total, failed: failedRuns }) => (
              <Link key={run.id} href={`/runs/${run.id}`} className="flex items-center gap-3 no-underline hover:text-mist text-[13px]">
                <span className={`pill ${run.status === "ok" ? "g" : run.status === "failed" ? "c" : "s"}`}>{messages.recipe.runStatus[run.status]}</span>
                <span className="min-w-0 flex-1 truncate">
                  <b className="font-medium">{byId.get(run.agentId)?.name}</b>
                  {title?.title && title.title !== byId.get(run.agentId)?.name ? ` · ${title.title}` : ""}
                  {run.summary ? <span className="text-ash"> · {run.summary}</span> : null}
                </span>
                {total > 1 && <span className="text-smoke text-[12px] whitespace-nowrap">{t.repeats(total, failedRuns)}</span>}
                <span className="text-smoke text-[12px] whitespace-nowrap">{formatWhen(run.startedAt)}</span>
              </Link>
            ))
          )}
        </section>
      </div>
      )}
    </div>
  );
}
