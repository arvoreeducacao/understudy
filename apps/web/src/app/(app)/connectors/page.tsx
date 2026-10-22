import { desc } from "drizzle-orm";
import { ServersAdmin } from "@/components/approvals/ServersAdmin";
import { getDb, schema } from "@/lib/db";
import { messages } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { canUseConnector } from "@/server/connector-rights";
import { listUpstreamTools } from "@/server/upstream";

const t = messages.admin;

export default async function ConnectorsPage() {
  const me = await requireUser();
  const servers = (await getDb().select().from(schema.mcpServers).orderBy(desc(schema.mcpServers.createdAt))).filter((server) => canUseConnector(me, server));
  const rows = await Promise.all(
    servers.map(async (server) => ({
      id: server.id,
      name: server.name,
      url: server.url,
      tools: await listUpstreamTools(server, me.id).then((tools) => tools.map((tool) => tool.name), () => null),
      askAll: server.askAll,
      askTools: server.askTools ?? [],
      allowedEmails: server.allowedEmails ?? null,
    })),
  );
  return (
    <div className="page">
      <div className="top">
        <div>
          <h1>{t.serversTitle}</h1>
          <p>{t.serversWhat}</p>
        </div>
      </div>
      <div className="page-body">
        <ServersAdmin servers={rows} />
      </div>
    </div>
  );
}
