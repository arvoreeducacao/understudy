export type ConnectorPreset = {
  id: string;
  name: string;
  url: string;
  headerName?: string;
  headerPrefix?: string;
  keyPage?: string;
};

export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", headerName: "Authorization", headerPrefix: "Bearer ", keyPage: "https://github.com/settings/personal-access-tokens" },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", headerName: "Authorization", headerPrefix: "Bearer ", keyPage: "https://linear.app/settings/account/security" },
  { id: "stripe", name: "Stripe", url: "https://mcp.stripe.com", headerName: "Authorization", headerPrefix: "Bearer ", keyPage: "https://dashboard.stripe.com/apikeys" },
  { id: "zapier", name: "Zapier", url: "https://mcp.zapier.com/api/mcp/mcp", headerName: "Authorization", headerPrefix: "Bearer ", keyPage: "https://mcp.zapier.com" },
  { id: "deepwiki", name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp" },
];
