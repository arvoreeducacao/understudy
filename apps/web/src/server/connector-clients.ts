import { featuredFor, type Connector } from "@/lib/connector-showcase";
import { env } from "@/lib/env";

export function presetClientFor(url: string) {
  return featuredFor(url)?.id === "slack" ? env.slackConnectorClient : null;
}

export function withPresetClient(connector: Connector): Connector {
  return connector.signIn && presetClientFor(connector.url) ? { ...connector, signIn: { needsClient: false } } : connector;
}
