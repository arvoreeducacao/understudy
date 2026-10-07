import { randomBytes } from "node:crypto";
import { auth, discoverOAuthServerInfo, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { open, seal } from "@/lib/secret-box";
import { safeFetch } from "./safe-fetch";

type Server = typeof schema.mcpServers.$inferSelect;

export const OAUTH_CALLBACK_PATH = "/api/connectors/oauth/callback";

export function oauthCallbackUrl() {
  return `${env.publicUrl.replace(/\/$/, "")}${OAUTH_CALLBACK_PATH}`;
}

export function usesOAuth(server: Pick<Server, "oauthClient" | "oauthTokens">) {
  return Boolean(server.oauthClient || server.oauthTokens);
}

function readSealed<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(open(value)) as T;
  } catch {
    return undefined;
  }
}

export class StoredOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;

  constructor(private server: Server) {}

  private async store(patch: Partial<Pick<Server, "oauthClient" | "oauthTokens" | "oauthState" | "oauthVerifier">>) {
    this.server = { ...this.server, ...patch };
    await getDb().update(schema.mcpServers).set(patch).where(eq(schema.mcpServers.id, this.server.id));
  }

  get redirectUrl() {
    return oauthCallbackUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Understudy",
      redirect_uris: [oauthCallbackUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async state() {
    const state = randomBytes(24).toString("base64url");
    await this.store({ oauthState: state });
    return state;
  }

  clientInformation() {
    return readSealed<OAuthClientInformationMixed>(this.server.oauthClient);
  }

  async saveClientInformation(information: OAuthClientInformationMixed) {
    await this.store({ oauthClient: seal(JSON.stringify(information)) });
  }

  tokens() {
    return readSealed<OAuthTokens>(this.server.oauthTokens);
  }

  async saveTokens(tokens: OAuthTokens) {
    await this.store({ oauthTokens: seal(JSON.stringify(tokens)) });
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(verifier: string) {
    await this.store({ oauthVerifier: seal(verifier) });
  }

  codeVerifier() {
    const verifier = this.server.oauthVerifier ? open(this.server.oauthVerifier) : "";
    if (!verifier) throw new Error("No sign-in is in progress for this connector");
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all") await this.store({ oauthTokens: null, oauthVerifier: null, oauthState: null });
    if (scope === "tokens") await this.store({ oauthTokens: null });
    if (scope === "verifier") await this.store({ oauthVerifier: null, oauthState: null });
    if (scope === "client" && this.server.oauthClient && !readSealed<OAuthClientInformationMixed>(this.server.oauthClient)?.client_secret)
      await this.store({ oauthClient: seal("null") });
  }
}

export type OAuthSupport = { supported: false } | { supported: true; registers: boolean };

export async function oauthSupport(url: string): Promise<OAuthSupport> {
  try {
    const info = await discoverOAuthServerInfo(url, { fetchFn: safeFetch });
    const metadata = info.authorizationServerMetadata;
    if (!metadata?.authorization_endpoint || !metadata.token_endpoint) return { supported: false };
    return { supported: true, registers: Boolean(metadata.registration_endpoint) };
  } catch {
    return { supported: false };
  }
}

export async function beginSignIn(server: Server) {
  const provider = new StoredOAuthProvider({ ...server, oauthTokens: null });
  await getDb().update(schema.mcpServers).set({ oauthTokens: null }).where(eq(schema.mcpServers.id, server.id));
  const result = await auth(provider, { serverUrl: server.url, fetchFn: safeFetch });
  const page = provider.authorizationUrl;
  if (result !== "REDIRECT" || !page) throw new Error("The server did not send a sign-in page");
  const local = process.env.UNDERSTUDY_ALLOW_PRIVATE_MCP === "1" && page.protocol === "http:";
  if (page.protocol !== "https:" && !local) throw new Error("The sign-in page is not an https address");
  return page.toString();
}

export async function finishSignIn(state: string, code: string) {
  const [server] = await getDb().select().from(schema.mcpServers).where(eq(schema.mcpServers.oauthState, state));
  if (!server) return null;
  const provider = new StoredOAuthProvider(server);
  let signedIn = true;
  try {
    await auth(provider, { serverUrl: server.url, authorizationCode: code, fetchFn: safeFetch });
  } catch (error) {
    signedIn = false;
    console.error(JSON.stringify({ event: "connector_sign_in_exchange_failed", url: server.url, error: String(error) }));
  }
  await getDb().update(schema.mcpServers).set({ oauthState: null, oauthVerifier: null }).where(eq(schema.mcpServers.id, server.id));
  const [fresh] = await getDb().select().from(schema.mcpServers).where(eq(schema.mcpServers.id, server.id));
  return fresh ? { server: fresh, signedIn } : null;
}

export async function abandonSignIn(state: string) {
  const [server] = await getDb().select().from(schema.mcpServers).where(eq(schema.mcpServers.oauthState, state));
  if (!server) return null;
  await getDb().update(schema.mcpServers).set({ oauthState: null, oauthVerifier: null }).where(eq(schema.mcpServers.id, server.id));
  return server;
}
