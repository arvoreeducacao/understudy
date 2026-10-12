# Channels

A channel is a place outside the panel where people hold a conversation with an understudy. Every channel shares the understudy's chat, memory, approvals and run history: a message on a channel is the same `chat` turn the panel sends, and the understudy's answer goes back where the conversation started.

| Channel | State | What the server needs | What an owner does |
|---|---|---|---|
| Slack | Built in | `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` (or pasted by an admin) | Writes to the app; their Slack account is matched to their panel account |
| Telegram | Built in | Nothing (reaches `api.telegram.org`) | Creates a bot with @BotFather, pastes its token, presses Start in the bot |
| Microsoft Teams | Documented adapter | An Azure Bot registration | Installs the app in Teams |
| WhatsApp | Documented adapter | A WhatsApp Business Cloud API number | Adds their phone number |
| SMS | Documented adapter | A Twilio (or compatible) number | Adds their phone number |

`UNDERSTUDY_CHANNELS` (default `telegram`) lists the per-understudy channels owners may turn on. Remove one to hide it from Settings and refuse its traffic. Slack is configured for the whole workspace instead (see [CONFIGURATION.md](CONFIGURATION.md)).

Email is not a conversation channel. To let an understudy read, search and draft in its owner's mailbox, connect a mail server as a connector; tasks can still start from an email address of their own.

## Who is who

Every channel sorts the person writing into one of three groups, per understudy:

- **The owner**, recognised by an identity the channel can prove: the Slack account matched to the panel account, or the Telegram account that opened the bot with the one-time Start link shown in Settings. The owner's message is a normal chat turn.
- **People the owner allowed** (Telegram usernames or ids, phone numbers in E.164). Their message reaches the brain with `external: { channel, sender }`: quoted as data, marked as not the owner, never able to approve anything. The answer goes back to them.
- **Anyone else** is held for the owner (Settings › Channels lists it with Let it through, Always allow and Discard, and the owner gets a note in the chat and a push) or dropped, as the owner chooses.

## How a conversation flows

1. The channel's endpoint authenticates the provider (Slack's request signature, a per-channel secret header for Telegram webhooks), finds the understudy, sorts the sender and either holds, drops or delivers.
2. Delivering records the conversation as the understudy's reply route for 30 minutes. A panel message clears it; a message on another channel takes it over.
3. While the route is active, the understudy's chat replies and the files it shares with `share_file` are buffered on the thread and sent as one reply when its turn ends, or after 90 seconds.
4. An approval requested while the route is active also goes to the owner on that channel, with Approve and Deny buttons that only the owner's account can press. The panel and push keep working as before.

## Telegram

- Each understudy has its own bot, so it keeps its own name and picture. Owners create it with @BotFather (`/newbot`) and paste the token; it is stored encrypted with `UNDERSTUDY_SECRET_KEY`.
- With an `https://` `UNDERSTUDY_PUBLIC_URL`, the panel registers a webhook at `/api/channels/telegram/<channel id>` with a secret Telegram sends back on every call. Without one (local installs), or with `UNDERSTUDY_TELEGRAM_POLL=1`, the panel polls `getUpdates` every few seconds instead; nothing has to reach the panel.
- Only private chats are answered. Photos and documents up to 20 MB (the Bot API download limit) land in the understudy's inbox; replies attach files up to 45 MB each.
- `UNDERSTUDY_TELEGRAM_API_URL` points at a self-hosted Bot API server if you run one.

## Writing an adapter

An adapter lives in `apps/web/src/server/channels/<kind>/` and is registered in `relay.ts`. It implements:

- `ready()`: whether the server settings it needs are present and the kind is in `UNDERSTUDY_CHANNELS`.
- `send(hub, { agentId, agentName, channel, thread, reply })`: deliver `reply.text` and `reply.files` (read them with `readReplyFiles`) to `thread.peer`, splitting text to the provider's limit, then `recordSent`.
- `sendApproval(hub, notice)` (optional): put the approval in front of the owner on this channel, with a way to answer that proves it is the owner. Without it, approvals reach the owner by the panel, Slack and push only.

Inbound, the adapter's endpoint verifies the provider, maps the destination to an `agent_channels` row (`kind`, `address`), decides `owner`, `allowed` or `unknown`, and calls `holdMessage` or `deliverToAgent` from `deliver.ts`. Per-kind identifiers for the allowed list are cleaned in `peers.ts`. Keep secrets in `agent_channels.secret` (sealed) and per-channel state in `settings` (merge it with `mergeChannelSettings`).

### Microsoft Teams (documented)

- Server: `UNDERSTUDY_TEAMS_APP_ID`, `UNDERSTUDY_TEAMS_APP_PASSWORD` and `UNDERSTUDY_TEAMS_TENANT_ID` from an Azure Bot registration (single tenant), messaging endpoint `https://<panel>/api/channels/teams`. One registration serves every understudy; the owner picks which understudy answers by installing a per-understudy app manifest the panel generates.
- Inbound: validate the Bot Framework JWT (issuer, audience = app id, signing keys from the OpenID metadata, `serviceUrl` claim) before reading the activity. Owner = the Entra ID object id linked once from Settings with a one-time code, like Telegram's Start link. Allowed list = Entra ID object ids or user principal names.
- Outbound: reply to the activity's `serviceUrl` and conversation id with an app token from `login.microsoftonline.com`; files go as attachments through a consent card in personal chats. Approvals are an Adaptive Card with Approve and Deny actions whose invoke is checked against the owner's object id.

### WhatsApp (documented)

- Use the official WhatsApp Business Platform Cloud API, directly with Meta or through a provider (360dialog, Twilio) that exposes the same webhooks. Unofficial WhatsApp Web libraries break the WhatsApp terms and get numbers banned; Understudy will not ship one.
- Server: `UNDERSTUDY_WHATSAPP_TOKEN` (a system user token), `UNDERSTUDY_WHATSAPP_APP_SECRET`, `UNDERSTUDY_WHATSAPP_VERIFY_TOKEN` and `UNDERSTUDY_WHATSAPP_PHONE_NUMBER_ID`, webhook `https://<panel>/api/channels/whatsapp`. One business number per installation; each contact talks to one understudy at a time and switches with a short command, since a number per understudy multiplies phone lines, display name reviews and provider fees.
- Inbound: answer the `hub.verify_token` challenge, check `X-Hub-Signature-256` with the app secret, then read `messages`. Owner = the phone number that sends a one-time code shown in Settings. Media is fetched with the token from the media id.
- Outbound: free-form replies only within 24 hours of the contact's last message; anything later needs a template approved by Meta, so late replies wait in the panel. Approvals use interactive reply buttons, checked against the owner's number.
- Meta's terms do not allow general-purpose AI assistants as the product itself; an understudy working for a business and its contacts is the allowed use, so describe it that way when registering.

### SMS (documented)

- Server: `UNDERSTUDY_SMS_ACCOUNT_SID`, `UNDERSTUDY_SMS_AUTH_TOKEN` (Twilio, or a provider with the same webhook signature), webhook `https://<panel>/api/channels/sms`. Each understudy gets its own number as the channel address.
- Inbound: verify `X-Twilio-Signature` over the full URL and form body. Owner = the phone number on the owner's account, confirmed with a one-time code. Media URLs are fetched with the account credentials (MMS).
- Outbound: split long replies into segments (or send a link to the panel for anything over a few segments); files go as MMS where the carrier supports it, otherwise as a link to a signed download. Approvals are a short message with the signed `/answer/<token>` link, since SMS has no buttons and the sender number alone is not proof enough to approve.
