"use client";

import { useState, useTransition } from "react";
import { answerHeld, relinkTelegramOwner, saveChannelSenders, saveUnknownSenders, setTelegramChannel } from "@/app/actions/channels";
import { Field, Input } from "@/components/ui/controls";
import { Segmented } from "@/components/ui/Segmented";
import type { ChannelKind, UnknownSenders } from "@/lib/db/schema";
import { messages } from "@/lib/messages";
import type { ChannelSettings, HeldView } from "@/server/channels/settings";
import { PanelSection } from "./PanelSection";

function HeldList({ agentId, initial }: { agentId: string; initial: HeldView[] }) {
  const t = messages.channels;
  const [held, setHeld] = useState(initial);
  const [pending, start] = useTransition();
  if (!held.length) return <p className="m-0 fld-hint">{t.heldEmpty}</p>;
  function act(id: string, action: "release" | "allow" | "discard") {
    start(async () => {
      const result = await answerHeld(agentId, id, action);
      if (result.ok) setHeld((list) => list.filter((item) => item.id !== id));
    });
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="fld-label">{t.heldTitle(held.length)}</span>
      <ul className="m-0 p-0 list-none flex flex-col gap-2">
        {held.map((item) => (
          <li key={item.id} className="card flex flex-col gap-1.5 p-3">
            <span className="text-[13px] font-medium break-all">{item.peerName ? `${item.peerName} · ${item.peer}` : item.peer}</span>
            {item.subject && <span className="text-[12.5px]">{item.subject}</span>}
            {item.preview && <span className="text-[12.5px] text-ash line-clamp-2">{item.preview}</span>}
            {item.files > 0 && <span className="text-[12px] text-ash">{t.heldFiles(item.files)}</span>}
            <div className="flex gap-2 flex-wrap pt-1">
              <button type="button" className="btn pri sm" disabled={pending} onClick={() => act(item.id, "release")}>
                {t.letThrough}
              </button>
              <button type="button" className="btn sec sm" disabled={pending} onClick={() => act(item.id, "allow")}>
                {t.alwaysAllow}
              </button>
              <button type="button" className="btn sec sm" disabled={pending} onClick={() => act(item.id, "discard")}>
                {t.discard}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WhoMayWrite({
  agentId,
  kind,
  initial,
  label,
  hint,
  placeholder,
}: {
  agentId: string;
  kind: ChannelKind;
  initial: { senders: string; unknown: UnknownSenders; held: HeldView[] };
  label: string;
  hint: string;
  placeholder: string;
}) {
  const t = messages.channels;
  const [senders, setSenders] = useState(initial.senders);
  const [saved, setSaved] = useState(initial.senders);
  const [unknown, setUnknown] = useState<UnknownSenders>(initial.unknown);
  const [pending, start] = useTransition();

  function saveSenders() {
    start(async () => {
      const result = await saveChannelSenders(agentId, kind, senders);
      setSenders(result.allowed);
      setSaved(result.allowed);
    });
  }

  function changeUnknown(mode: UnknownSenders) {
    setUnknown(mode);
    start(async () => {
      const result = await saveUnknownSenders(agentId, kind, mode);
      setUnknown(result.mode);
    });
  }

  return (
    <>
      <Field label={label} hint={hint}>
        <Input size="sm" value={senders} placeholder={placeholder} onChange={(e) => setSenders(e.target.value)} />
      </Field>
      {senders !== saved && (
        <button type="button" className="btn pri sm self-start" disabled={pending} onClick={saveSenders}>
          {t.save}
        </button>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="fld-label">{t.unknownTitle}</span>
        <Segmented
          label={t.unknownTitle}
          options={[
            { value: "hold", label: t.unknownHold },
            { value: "ignore", label: t.unknownIgnore },
          ]}
          value={unknown}
          onChange={changeUnknown}
          disabled={pending}
        />
      </div>
      {unknown === "hold" && <HeldList key={initial.held.map((item) => item.id).join(",")} agentId={agentId} initial={initial.held} />}
    </>
  );
}

function TelegramChannel({ agentId, initial }: { agentId: string; initial: ChannelSettings["telegram"] }) {
  const t = messages.channels;
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!initial.available && !initial.connected) return null;

  function connect() {
    setError(null);
    start(async () => {
      const result = await setTelegramChannel(agentId, token);
      if (result.ok) setToken("");
      else setError(t.telegramErrors[result.error] ?? t.telegramErrors.rejected);
    });
  }

  if (!initial.connected) {
    return (
      <div className="flex flex-col gap-2.5">
        <p className="m-0 fld-hint">{t.telegramIntro}</p>
        <p className="m-0 fld-hint">{t.telegramSteps}</p>
        <Field label={t.telegramToken} error={error ?? undefined}>
          <Input size="sm" className="font-mono" type="password" autoComplete="off" value={token} placeholder="123456789:AA..." onChange={(e) => setToken(e.target.value)} />
        </Field>
        <button type="button" className="btn sec sm self-start" disabled={pending || !token.trim()} onClick={connect}>
          {t.telegramConnect}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 fld-hint">{t.telegramIntro}</p>
      {initial.username && <span className="text-[13px] font-medium">{t.telegramBot(initial.username)}</span>}
      {initial.pairLink ? (
        <div className="flex flex-col gap-1.5">
          <a className="btn pri sm self-start" href={initial.pairLink} target="_blank" rel="noreferrer">
            {t.telegramLinkOwner}
          </a>
          <span className="fld-hint">{t.telegramLinkHint}</span>
        </div>
      ) : (
        initial.ownerName && (
          <div className="flex gap-2 items-center flex-wrap">
            <span className="text-[12.5px] text-ash">{t.telegramOwner(initial.ownerName)}</span>
            <button type="button" className="btn sec sm" disabled={pending} onClick={() => start(async () => void (await relinkTelegramOwner(agentId)))}>
              {t.telegramRelink}
            </button>
          </div>
        )
      )}
      {initial.polling && <p className="m-0 fld-hint">{t.telegramPolling}</p>}
      <WhoMayWrite agentId={agentId} kind="telegram" initial={initial} label={t.telegramSenders} hint={t.telegramSendersHint} placeholder="someone_example, 123456789" />
      <button type="button" className="btn sec sm self-start" disabled={pending} onClick={() => start(async () => void (await setTelegramChannel(agentId, null)))}>
        {t.disable}
      </button>
    </div>
  );
}

export function ChannelsSection({ agentId, channels }: { agentId: string; channels: ChannelSettings }) {
  const t = messages.channels;
  const { telegram } = channels;
  if (!telegram.available && !telegram.connected) return null;
  const on = telegram.connected ? 1 : 0;
  const waiting = telegram.unknown === "hold" ? telegram.held.length : 0;
  return (
    <PanelSection title={t.title} hint={waiting ? `${t.summary(on)} · ${t.heldTitle(waiting)}` : t.summary(on)} collapsible>
      <div className="flex flex-col gap-2">
        <span className="fld-label">{t.telegramTitle}</span>
        <TelegramChannel agentId={agentId} initial={telegram} />
      </div>
    </PanelSection>
  );
}
