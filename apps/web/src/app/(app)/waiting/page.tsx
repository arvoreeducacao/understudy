import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { accessibleAgentIds } from "@/lib/access";
import { ApprovalItem } from "@/components/approvals/ApprovalItem";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getDb, schema } from "@/lib/db";
import { formatWhen } from "@/lib/format";
import { messages } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { EmptyState } from "@/components/ui/EmptyState";

const t = messages.approvals;

export default async function WaitingPage() {
  const user = await requireUser();
  const db = getDb();
  const ids = await accessibleAgentIds(user.id, ["owner", "approver"]);
  const scope = ids.length ? inArray(schema.agents.id, ids) : eq(schema.agents.id, "");
  const base = db
    .select({ approval: schema.approvals, agent: schema.agents })
    .from(schema.approvals)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.approvals.agentId));
  const pending = await base
    .where(and(scope, eq(schema.approvals.status, "pending")))
    .orderBy(desc(schema.approvals.createdAt));
  const answered = await db
    .select({ approval: schema.approvals, agent: schema.agents })
    .from(schema.approvals)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.approvals.agentId))
    .where(and(scope, ne(schema.approvals.status, "pending")))
    .orderBy(desc(schema.approvals.createdAt))
    .limit(20);
  return (
    <div className="page narrow">
      <AutoRefresh />
      <div className="top">
        <div>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
      </div>
      <div className="flex flex-col gap-3 py-6">
        {pending.length === 0 && answered.length === 0 && (
          <EmptyState framed mood="happy" title={messages.empty.waitingTitle} body={messages.empty.waitingBody} action={{ href: "/settings", label: messages.empty.waitingAction, secondary: true }} />
        )}
        {pending.length === 0 && answered.length > 0 && <EmptyState size="sm" mood="happy" title={messages.empty.waitingTitle} />}
        {pending.map(({ approval, agent }) => (
          <ApprovalItem
            key={approval.id}
            approval={{ id: approval.id, summary: approval.summary, fields: approval.fields }}
            agent={{ id: agent.id, name: agent.name, look: agent.look }}
            when={formatWhen(approval.createdAt)}
          />
        ))}
        {answered.length > 0 && (
          <>
            <h2 className="text-[14px] font-semibold text-ash mt-6 mb-0">{t.history}</h2>
            {answered.map(({ approval, agent }) => (
              <div key={approval.id} className="flex items-center gap-3 text-[13px] border-t border-graphite pt-3">
                <span className="text-smoke whitespace-nowrap">{formatWhen(approval.createdAt)}</span>
                <span className="min-w-0 flex-1 truncate">
                  <b className="font-medium">{agent.name}</b> · {approval.summary}
                  {approval.note ? <span className="text-smoke"> · {approval.note}</span> : null}
                </span>
                <span className={`pill ${approval.status === "approved" ? "g" : approval.status === "denied" ? "c" : ""}`}>
                  {t.status[approval.status]}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
