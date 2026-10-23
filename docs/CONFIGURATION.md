# Configuration

Everything is configured through `.env` at the repository root (copy `example.env`). Only `BETTER_AUTH_SECRET` and `UNDERSTUDY_HOST_TOKEN` are required.

**Panel**

| Variable | Meaning |
|---|---|
| `BETTER_AUTH_SECRET` | Signs sessions; keep it secret and stable |
| `UNDERSTUDY_HOST_TOKEN` | Shared secret between the panel and the host |
| `UNDERSTUDY_SECRET_KEY` | Encrypts stored tool credentials; defaults to `BETTER_AUTH_SECRET` |
| `UNDERSTUDY_PUBLIC_URL` | Address people use to open the panel |
| `UNDERSTUDY_COMPUTER_SERVER_URL` | Address computers use to reach the panel; defaults to the public URL, and the compose default works with Docker Desktop and Linux |
| `UNDERSTUDY_ADMIN_EMAILS` | Comma-separated admins; empty lets the first account become admin |
| `UNDERSTUDY_ALLOWED_EMAIL_DOMAIN` | Only these email domains (comma separated) can have accounts and sign up; empty closes public sign-up, so accounts come from an admin, the `create-user` command or Google |
| `UNDERSTUDY_HOST_IDS` | Host ids allowed to connect; empty trusts the first host and asks an admin about any other |
| `UNDERSTUDY_BLOCKED_CIDRS` | Extra address ranges connected tools may never use; private, loopback, link-local, metadata and CGNAT ranges are always blocked |
| `UNDERSTUDY_ALLOW_PRIVATE_MCP` | `1` lets connected tools live on private addresses; local development only |
| `UNDERSTUDY_PRODUCT_NAME` | Name shown in the panel; default `Understudy` |
| `UNDERSTUDY_ARTIFACT_S3_BUCKET` | Bucket for artifact versions and page images. Any S3-compatible store works (AWS S3, MinIO, SeaweedFS, Garage). Empty keeps them in Postgres |
| `UNDERSTUDY_ARTIFACT_S3_ENDPOINT`, `UNDERSTUDY_ARTIFACT_S3_REGION` | Endpoint (default `https://s3.<region>.amazonaws.com`, path-style) and region (default `AWS_REGION` or `us-east-1`) |
| `UNDERSTUDY_ARTIFACT_S3_ACCESS_KEY_ID`, `UNDERSTUDY_ARTIFACT_S3_SECRET_ACCESS_KEY` | Keys for that bucket; fall back to `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` |
| `UNDERSTUDY_ARTIFACT_MAX_BYTES` | Largest file one artifact version can hold (25 MB by default) |
| `UNDERSTUDY_ARTIFACT_AGENT_MAX_BYTES` | Total size of every artifact version one understudy can keep (1 GB by default) |
| `UNDERSTUDY_ARTIFACT_ORIGIN` | Optional separate origin (another registrable domain) that serves artifact content; without it content is served from the panel host, already sandboxed with an opaque origin |
| `UNDERSTUDY_LOCALE` | `en` (default) or `pt-BR` |
| `UNDERSTUDY_TIMEZONE` | Time zone for dates and new schedules; default `UTC` |
| `UNDERSTUDY_FOLLOWUP_MAX_CHAIN_WAKES` | Most times one chain of follow-ups can wake an understudy before it stops and the owner is told; default `30` |
| `UNDERSTUDY_FOLLOWUP_MAX_DAILY_WAKES` | Most follow-up wakes per understudy in 24 hours; default `48` |
| `UNDERSTUDY_AGENT_TALK_CEILING` | Most turns in a row understudies may take talking among themselves, in rooms and through messages and hand-offs; empty means no limit, and the owner can always press Stop |
| `UNDERSTUDY_BRIEFING_CRON` | When owners get their daily Slack briefing; default `0 8 * * 1-5` |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | Lets understudies talk on Slack; an admin can also paste both in the panel under People |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Adds Google sign-in |
| `UNDERSTUDY_GOOGLE_ONLY_DOMAINS` | Domains (comma separated) that sign in only with Google; they skip password and two-step sign-in. Ignored unless Google sign-in is set |
| `UNDERSTUDY_INBOUND_EMAIL_DOMAIN` | Domain whose mail starts tasks; each task gets `<task>.<random>@<domain>`. Empty turns inbound email off |
| `UNDERSTUDY_INBOUND_SNS_TOPIC_ARN`, `UNDERSTUDY_INBOUND_S3_BUCKET` | With Amazon SES receiving: the only SNS topic and S3 bucket the panel accepts mail from |
| `UNDERSTUDY_INBOUND_TOKEN` | With any other provider: bearer token (24+ characters) for posting raw MIME to `/api/inbound/email` |
| `UNDERSTUDY_CHANNELS` | Per-understudy conversation channels owners may turn on; default `telegram,whatsapp`. See [CHANNELS.md](CHANNELS.md) |
| `UNDERSTUDY_TELEGRAM_POLL` | `1` makes the panel poll Telegram instead of registering a webhook; automatic when `UNDERSTUDY_PUBLIC_URL` is not HTTPS |
| `UNDERSTUDY_TELEGRAM_API_URL` | A self-hosted Telegram Bot API server; default `https://api.telegram.org` |

**Host**

| Variable | Meaning |
|---|---|
| `UNDERSTUDY_COMPUTER_IMAGE` | The only computer image the host runs; default `understudy-computer:local` |
| `UNDERSTUDY_HOST_ID` | Name the host reports to the panel |
| `UNDERSTUDY_HOST_CAPACITY` | Maximum computers at once; default one per 2 GB of memory, keeping 2 GB |
| `UNDERSTUDY_COMPUTER_NETWORK` | Docker network for computers, created without inter-container traffic; default `understudy-agents` |
| `UNDERSTUDY_COMPUTER_EXTRA_HOSTS` | Extra host names for computers; the compose default lets them reach the panel on this machine |
| `UNDERSTUDY_ALWAYS_PULL` | `1` pulls the computer image every time a computer starts |
| `UNDERSTUDY_COMPUTER_ENV` | Comma-separated names of the variables below to forward to every computer |

**Computer** (forwarded through `UNDERSTUDY_COMPUTER_ENV`)

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` with `ANTHROPIC_AUTH_TOKEN` | Run the Claude brain on an API key or gateway instead of each owner's subscription |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | The same for the ChatGPT brain |
| `UNDERSTUDY_ENABLE_CODEX` | `true` offers the ChatGPT (Codex) brain, which is experimental |
| `UNDERSTUDY_RUN_MODEL` | A faster Claude model for task runs, such as `haiku`. A run starts on it; if it stops before finishing and the owner did not refuse anything, the agent's main model takes over in the same session. Ignored when the agent's own model is already this one, and never used to retry a signed-out brain. Unset, runs use the main model only |
| `UNDERSTUDY_FAKE_BRAIN` | `1` replaces the brain with a scripted one, for testing without any account |

For example, to run every understudy on one Anthropic key, set `ANTHROPIC_API_KEY` and `UNDERSTUDY_COMPUTER_ENV=ANTHROPIC_API_KEY`.

## Talking on Telegram

Owners connect a bot of their own per understudy under Settings › Channels: create it with @BotFather, paste the token, then open the bot with the Start link shown there so their Telegram account counts as the owner. Nothing is needed on the server. Everything else (allowed people, held messages, approvals with buttons) works as described in [CHANNELS.md](CHANNELS.md).

## Reading the owner's email

An understudy reads, searches and drafts in its owner's mailbox through a connector, under the owner's own account. Nothing is configured on the server.

**Gmail.** Uses Google's remote Gmail MCP server (`https://gmailmcp.googleapis.com/mcp/v1`, in preview at the time of writing).

1. In a Google Cloud project, enable the Gmail API and the Gmail MCP API, and create an OAuth client of type Web application. Its authorized redirect URI is the return address the panel shows.
2. In the panel, an admin opens People › Connectors, picks Gmail, and pastes the client ID and secret.
3. Each owner signs in with their own Google account from the understudy's settings.
4. The panel asks Google only for `gmail.readonly` and `gmail.compose`, and asks for offline access so the sign-in keeps working.

The server has no send tool: the understudy writes drafts, and the owner sends them from Gmail. The server marks its search, read and list tools read-only and its draft, label, trash and spam tools as changes; the label, trash and spam tools also need a wider Google permission than the panel asks for, so they fail instead of acting. Because only the read tools are marked read-only, every draft, label, trash and spam tool starts as Ask for each understudy, and the owner approves each call unless they change it.

**Outlook.** Add a Microsoft 365 MCP server as a custom connector:

- Microsoft's own Mail server in Agent 365 needs Copilot licensing.
- A self-hosted open-source server such as `ms-365-mcp-server` can run read-only, or limited to `Mail.Read` and `Mail.ReadWrite`.

If the server can send, its send, reply and send-draft actions start as Ask unless the server marks them read-only. To make sure no owner switches them to Allow, set them to Always ask (or Never) under Limits for everyone on the connector's page. An approval covers only the exact arguments it showed.

## Starting tasks by email

Each task can get its own email address. Mail to it starts the task with the email quoted as untrusted data (sender, subject, text) and its attachments saved in the understudy's inbox; approvals are always required on these runs. By default only senders from the owner's email domain are accepted, and each task can list other addresses or domains.

- **Amazon SES:** `infra/aws/06-inbound-email.sh` sets up receiving on a subdomain (MX and DKIM records, an encrypted S3 bucket that keeps mail 30 days, an SNS topic that notifies the panel, and a role the panel uses to read the mail). The panel checks the SNS signature, the topic and the bucket, and only accepts mail that passes DMARC and the spam and virus scans.
- **Any other provider:** forward each message as raw MIME with `POST /api/inbound/email`, `Authorization: Bearer $UNDERSTUDY_INBOUND_TOKEN`, `Content-Type: message/rfc822` and, optionally, `X-Understudy-Recipients: a@your.domain,b@your.domain`. Authenticating the sender (SPF, DKIM, DMARC) is then your provider's job.

