import { asc } from "drizzle-orm";
import { serverAllowedFor } from "@/server/approval-payload";
import { listUpstreamTools } from "@/server/upstream";
import { getDb, schema } from "./db";

export async function serverOptions(email: string) {
  const servers = (await getDb().select().from(schema.mcpServers).orderBy(asc(schema.mcpServers.name))).filter((server) =>
    serverAllowedFor(server.allowedEmails, email),
  );
  return Promise.all(
    servers.map(async (server) => ({
      id: server.id,
      name: server.name,
      askAll: server.askAll,
      adminAsk: server.askTools ?? [],
      tools: await listUpstreamTools(server).then(
        (tools) => tools.map((tool) => ({ name: tool.name, description: tool.description })),
        () => null,
      ),
    })),
  );
}
