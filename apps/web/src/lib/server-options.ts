import { asc } from "drizzle-orm";
import { featuredFor } from "@/lib/connector-showcase";
import { serverAllowedFor, teamConnector } from "@/server/approval-payload";
import { loginOf, usesOAuth } from "@/server/connector-oauth";
import { ceilingOf, listUpstreamTools, loadToolLimits } from "@/server/upstream";
import { getDb, schema } from "./db";

export async function serverOptions(user: { id: string; email: string }, team = false) {
  const servers = (await getDb().select().from(schema.mcpServers).orderBy(asc(schema.mcpServers.name))).filter(
    (server) => serverAllowedFor(server.allowedEmails, user.email) && (!team || teamConnector(server)),
  );
  const limits = await loadToolLimits(servers.map((server) => server.id));
  return Promise.all(
    servers.map(async (server) => ({
      id: server.id,
      name: server.name,
      ceiling: ceilingOf(server, limits.get(server.id)),
      signIn: usesOAuth(server) ? { signedIn: Boolean((await loginOf(server.id, user.id))?.tokens) } : undefined,
      slackProfile: featuredFor(server.url)?.id === "slack",
      tools: await listUpstreamTools(server, user.id).then(
        (tools) => tools.map((tool) => ({ name: tool.name, description: tool.description, ...(tool.annotations ? { annotations: tool.annotations } : {}) })),
        () => null,
      ),
    })),
  );
}
