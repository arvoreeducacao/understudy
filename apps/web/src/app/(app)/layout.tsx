import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import { AgentFigure } from "@/components/AgentFigure";
import { NavLink } from "@/components/NavLink";
import { SideShell } from "@/components/SideShell";
import { SignOut } from "@/components/SignOut";
import { accessibleAgentIds, approvalScope } from "@/lib/access";
import { getDb, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { messages } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { loadOpenFailures } from "@/server/run-alerts";
import { teamsFor } from "@/server/teams-store";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const db = getDb();
  const waiting = (
    await db
      .select({ id: schema.approvals.id })
      .from(schema.approvals)
      .where(and(await approvalScope(user.id), eq(schema.approvals.status, "pending")))
  ).length;
  const failing = (await loadOpenFailures(await accessibleAgentIds(user.id, ["owner"]))).length;
  const admin = user.admin;
  const teams = await teamsFor(user.id);
  const pendingUsers = admin
    ? (await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.status, "pending"))).length
    : 0;

  return (
    <div className="app">
      <SideShell
        waiting={waiting + failing}
        moreAlert={pendingUsers}
        brand={
        <Link href="/" className="brand">
          <AgentFigure size={28} />
          {env.productName}
        </Link>
        }
        nav={
        <nav className="nav">
          <NavLink href="/today" icon="today">{messages.nav.today}</NavLink>
          <NavLink href="/waiting" icon="waiting" badge={waiting + failing}>
            {messages.nav.waiting}
          </NavLink>
          <NavLink href="/" exact icon="agents">
            {messages.nav.agents}
          </NavLink>
          <NavLink href="/recipes" icon="tasks">{messages.nav.recipes}</NavLink>
          <NavLink href="/rooms" icon="rooms">{messages.rooms.nav}</NavLink>
          <NavLink href="/teams" exact icon="team">{messages.teams.nav}</NavLink>
          {teams.map((team) => (
            <NavLink key={team.id} href={`/teams/${team.id}`} sub>
              <span className="truncate">{team.name}</span>
            </NavLink>
          ))}
          <div className="nav-group">{messages.nav.groupTeach}</div>
          <NavLink href="/templates" icon="templates">{messages.nav.templates}</NavLink>
          <NavLink href="/extension" icon="extension">{messages.extension.nav}</NavLink>
          <div className="nav-group">{messages.nav.groupSetup}</div>
          <NavLink href="/connectors" icon="connectors">{messages.nav.connectors}</NavLink>
          {admin && (
            <NavLink href="/admin" icon="people" badge={pendingUsers}>
              {messages.nav.admin}
            </NavLink>
          )}
          <NavLink href="/settings" icon="settings">{messages.nav.settings}</NavLink>
        </nav>
        }
        who={
        <div className="who">
          <div className="av">{initials(user.name || user.email)}</div>
          <div className="min-w-0">
            <div className="truncate text-mist">{user.name}</div>
            <SignOut />
          </div>
        </div>
        }
      />
      <main className="main">{children}</main>
    </div>
  );
}
