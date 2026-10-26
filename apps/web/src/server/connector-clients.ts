import type { Connector } from "@/lib/connector-showcase";
import { env } from "@/lib/env";
import { isSlackProfile } from "@/lib/slack-profile";

export function presetClientFor(url: string) {
  return isSlackProfile(url) ? env.slackConnectorClient : null;
}

export function withPresetClient(connector: Connector): Connector {
  return connector.signIn && presetClientFor(connector.url) ? { ...connector, signIn: { needsClient: false } } : connector;
}
