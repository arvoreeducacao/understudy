# Channels

A channel is a place outside the panel where people hold a conversation with an understudy. Every channel shares the understudy's chat, memory, approvals and run history: a message on a channel is the same `chat` turn the panel sends, and the understudy's answer goes back where the conversation started.

| Channel | State | What the server needs | What an owner does |
|---|---|---|---|
| Slack | Built in | `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` (or pasted by an admin) | Writes to the app; their Slack account is matched to their panel account |
| Telegram | Built in | Nothing (reaches `api.telegram.org`) | Creates a bot with @BotFather, pastes its token, presses Start in the bot |
| Microsoft Teams | Documented adapter | An Azure Bot registration | Installs the app in Teams |
| WhatsApp | Built in, opt-in | Nothing | Links their own WhatsApp with a QR code, like WhatsApp Web |
| SMS | Documented adapter | A Twilio (or compatible) number | Adds their phone number |

`UNDERSTUDY_CHANNELS` (default `telegram,whatsapp`) lists the per-understudy channels owners may turn on. Remove one to hide it from Settings and refuse its traffic. Slack is configured for the whole workspace instead (see [CONFIGURATION.md](CONFIGURATION.md)).

Email is not a conversation channel. To let an understudy read, search and draft in its owner's mailbox, connect a mail server as a connector; tasks can still start from an email address of their own.

## Who is who

Every channel sorts the person writing into one of three groups, per understudy:

- **The owner**, recognised by an identity the channel can prove: the Slack account matched to the panel account, the Telegram account that opened the bot with the one-time Start link shown in Settings, or the owner's own WhatsApp "Message yourself" chat. The owner's message is a normal chat turn.
- **People the owner allowed** (Telegram usernames or ids, phone numbers with country code for WhatsApp, matched on the number and never on the display name; a Telegram username is replaced by the account id the first time it writes). Their message reaches the brain with `external: { channel, sender }`: quoted as data, marked as not the owner, never able to approve anything. It runs in a session of its own, separate from the owner's chat, with no built-in tools and only the restricted gatekeeper address, which offers nothing but asking for approval and telling the owner (labelled with who the understudy was answering, and rate limited). The answer goes back to them.
- **Anyone else** is held for the owner (Settings › Channels lists it with Let it through, Always allow and Discard, and the owner gets a note in the chat and a push) or dropped, as the owner chooses.

## Slack and team understudies

On Slack, people are panel accounts: the Slack account is matched to the panel account by email or by the link the app sends. Besides the owner, these people can talk to a team understudy there:

- **Its team.** Anyone who may chat with it in the panel can mention it or message the app. The turn is theirs, as in the panel: a session of its own, messages only they see, and approvals that wait for them.
- **Anyone with an account**, when the owner turns on "Anyone with an account can talk to it on Slack" in the understudy's settings. The turn is private to that person in the same way, but they cannot book follow-ups, and whatever needs approval goes to the owner and the understudy's approvers by direct message, never into the thread.

Each of these conversations is a row in `slack_asker_threads` (understudy, person, channel, thread), kept for 7 days so a later mention in the same thread reaches the same understudy without its name. The message carries the row as `origin`; when the computer starts the turn, the panel takes the row only if it belongs to the person the ledger expected for that turn, and the replies go to that thread only. The owner's own Slack conversation (`slack_threads`) is never taken over by someone else's message.

A message that starts with an understudy's name goes to that understudy. Without a name, and outside a thread that already belongs to one, it goes to the person's own understudy when they have exactly one; a person with none of their own reaches their team's understudy the same way. An understudy opened to everyone answers only when it is named, so opening one never changes where anyone else's messages go.

## How a conversation flows

1. The channel's endpoint authenticates the provider (Slack's request signature, a per-channel secret header for Telegram webhooks), finds the understudy, sorts the sender and either holds, drops or delivers.
2. Each message carries the thread it came from, and the computer reports which thread each turn belongs to. Replies and shared files go to that thread only; a turn that started in the panel or on Slack never sends anything to a channel thread. A message from the owner also makes that thread the owner's current conversation for approvals (30 minutes); a panel message clears it, and a message on another channel takes it over.
3. The turn's replies and the files it shares with `share_file` are buffered on its thread and sent as one reply when the turn ends, or after 90 seconds.
4. An approval requested while the route is active also goes to the owner on that channel, with Approve and Deny buttons that only the owner's account can press. The panel and push keep working as before.

## Telegram

- Each understudy has its own bot, so it keeps its own name and picture. Owners create it with @BotFather (`/newbot`) and paste the token; it is stored encrypted with `UNDERSTUDY_SECRET_KEY`.
- With an `https://` `UNDERSTUDY_PUBLIC_URL`, the panel registers a webhook at `/api/channels/telegram/<channel id>` with a secret Telegram sends back on every call. Without one (local installs), or with `UNDERSTUDY_TELEGRAM_POLL=1`, the panel polls `getUpdates` every few seconds instead; nothing has to reach the panel.
- Only private chats are answered. Photos and documents up to 20 MB (the Bot API download limit) land in the understudy's inbox; replies attach files up to 45 MB each.
- `UNDERSTUDY_TELEGRAM_API_URL` points at a self-hosted Bot API server if you run one.

## WhatsApp

The owner links their own WhatsApp account to one understudy, the way WhatsApp Web is linked: Settings › Channels › WhatsApp shows a QR code to scan from WhatsApp › Linked devices. The panel then holds a linked-device session for that account with [Baileys](https://github.com/WhiskeySockets/Baileys), the maintained open-source WhatsApp Web library (MIT).

- **It is the person's own account, through an unofficial protocol.** It is not WhatsApp's business API, and WhatsApp may restrict or ban accounts that automate messages. The connect screen says so, and it is off until the owner turns it on for one understudy. An admin can remove `whatsapp` from `UNDERSTUDY_CHANNELS` to hide it.
- **Who it listens to.** The owner talks to the understudy in their own "Message yourself" chat. People the owner lists by number reach it as someone else, and the understudy's replies to them go out from the owner's own number, written by the AI. Everything else, including every other conversation on the account, is ignored by default and never stored. The owner can choose to hold messages from unlisted people instead.
- **Approvals.** An approval raised during a WhatsApp conversation arrives in the owner's own chat. The owner replies `1` to approve or `2` to deny. When more than one request is waiting, a reply without its three-letter code answers nothing and the understudy asks which one.
- **Session.** The linked-device keys are stored in `channel_secrets`, encrypted with `UNDERSTUDY_SECRET_KEY`, and the panel reconnects them after a restart.
  - A dropped connection retries with backoff.
  - If WhatsApp ends the link (logged out from the phone, or the session is refused), the keys are deleted and the owner is told in the panel chat, on Slack and by push.
- **Pace.** Before each message it shows "typing" for a time proportional to the length (about one to six seconds). It sends at most about 15 messages a minute per account, one at a time. It never marks the account online, so the phone keeps getting notifications.
- **Limits.** Group chats, broadcasts and channels are ignored. Received photos, documents, voice notes and videos up to 20 MB land in the understudy's inbox (the download stops as soon as it passes the limit, whatever size the sender declared); replies attach files up to 30 MB.
- **Deployment.** Sessions live in the panel process, so run one panel replica, or pin WhatsApp to one replica.

## Writing an adapter

An adapter lives in `apps/web/src/server/channels/<kind>/` and is registered in `relay.ts`. Every reply the understudy writes goes through one place: `currentConversation` picks the conversation that spoke last, across the buffered routes in `channel_routes` and every adapter's live conversation, and `relayReply` hands the text to that adapter. An adapter implements one of two shapes:

- **Buffered** (Telegram, WhatsApp, and the documented Teams and SMS): `send(hub, { agentId, agentName, channel, thread, reply })` delivers the turn's text and files (`readReplyFiles`) to `thread.peer`, split to the provider's limit, then calls `recordSent`. Optionally `sendApproval(hub, notice)` puts the approval in front of the owner with a way to answer that proves it is the owner.
- **Live** (Slack): `live.activeSince(agentId)` says when its conversation last spoke; `say` posts each reply as it comes, `delta` streams a reply being written, `activity` shows what the understudy is doing, `approval` posts the approval in the conversation, `panelSaid` mirrors a message typed in the panel, and `runStarted`/`runFinished` keep a task's progress in place.

`ready()` says whether the server settings it needs are present and the kind is enabled.

Inbound, the adapter's endpoint verifies the provider, maps the destination to an `agent_channels` row (`kind`, `address`), decides `owner`, `allowed` or `unknown`, and calls `holdMessage` or `deliverToAgent` from `deliver.ts`. Slack keeps its own inbound handling (workspace users matched to panel accounts, mentions routed by name, slash command) and its thread state in `slack_threads`. Per-kind identifiers for the allowed list are cleaned in `peers.ts`. Keep secrets in `agent_channels.secret` (sealed) and per-channel state in `settings` (merge it with `mergeChannelSettings`).

### Microsoft Teams (documented)

- Server: `UNDERSTUDY_TEAMS_APP_ID`, `UNDERSTUDY_TEAMS_APP_PASSWORD` and `UNDERSTUDY_TEAMS_TENANT_ID` from an Azure Bot registration (single tenant), messaging endpoint `https://<panel>/api/channels/teams`. One registration serves every understudy; the owner picks which understudy answers by installing a per-understudy app manifest the panel generates.
- Inbound: validate the Bot Framework JWT (issuer, audience = app id, signing keys from the OpenID metadata, `serviceUrl` claim) before reading the activity. Owner = the Entra ID object id linked once from Settings with a one-time code, like Telegram's Start link. Allowed list = Entra ID object ids or user principal names.
- Outbound: reply to the activity's `serviceUrl` and conversation id with an app token from `login.microsoftonline.com`; files go as attachments through a consent card in personal chats. Approvals are an Adaptive Card with Approve and Deny actions whose invoke is checked against the owner's object id.

### SMS (documented)

- Server: `UNDERSTUDY_SMS_ACCOUNT_SID`, `UNDERSTUDY_SMS_AUTH_TOKEN` (Twilio, or a provider with the same webhook signature), webhook `https://<panel>/api/channels/sms`. Each understudy gets its own number as the channel address.
- Inbound: verify `X-Twilio-Signature` over the full URL and form body. Owner = the phone number on the owner's account, confirmed with a one-time code. Media URLs are fetched with the account credentials (MMS).
- Outbound: split long replies into segments (or send a link to the panel for anything over a few segments); files go as MMS where the carrier supports it, otherwise as a link to a signed download. Approvals are a short message with the signed `/answer/<token>` link, since SMS has no buttons and the sender number alone is not proof enough to approve.
