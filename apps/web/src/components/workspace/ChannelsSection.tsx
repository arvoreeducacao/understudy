"use client";

import { useState, useTransition } from "react";
import { answerHeld, saveEmailSenders, saveUnknownSenders, setEmailChannel } from "@/app/actions/channels";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Field, Input } from "@/components/ui/controls";
import { Segmented } from "@/components/ui/Segmented";
import type { UnknownSenders } from "@/lib/db/schema";
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
            <span className="text-[12.5px]">{item.subject || t.heldNoSubject}</span>
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

function EmailChannel({ agentId, initial }: { agentId: string; initial: ChannelSettings["email"] }) {
  const t = messages.channels;
  const [address, setAddress] = useState(initial.address);
  const [senders, setSenders] = useState(initial.senders);
  const [saved, setSaved] = useState(initial.senders);
  const [unknown, setUnknown] = useState<UnknownSenders>(initial.unknown);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  if (!initial.available && !address) return <p className="m-0 fld-hint">{t.emailUnavailable}</p>;

  function toggle(enabled: boolean) {
    start(async () => {
      const result = await setEmailChannel(agentId, enabled);
      setAddress(result.address);
      setCopied(false);
    });
  }

  function saveSenders() {
    start(async () => {
      const result = await saveEmailSenders(agentId, senders);
      setSenders(result.allowed);
      setSaved(result.allowed);
    });
  }

  function changeUnknown(mode: UnknownSenders) {
    setUnknown(mode);
    start(async () => {
      const result = await saveUnknownSenders(agentId, mode);
      setUnknown(result.mode);
    });
  }

  if (!address) {
    return (
      <div className="flex flex-col gap-2.5">
        <p className="m-0 fld-hint">{t.emailIntro}</p>
        <button type="button" className="btn sec sm self-start" disabled={pending} onClick={() => toggle(true)}>
          {t.emailEnable}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 fld-hint">{t.emailIntro}</p>
      <div className="flex gap-2">
        <Input size="sm" className="font-mono" readOnly value={address} onFocus={(e) => e.target.select()} aria-label={t.emailAddress} />
        <button
          type="button"
          className="btn sec sm"
          onClick={() => {
            navigator.clipboard?.writeText(address).then(() => setCopied(true), () => undefined);
          }}
        >
          {copied ? t.copied : t.copy}
        </button>
      </div>
      <Field label={t.emailSenders} hint={t.emailSendersHint}>
        <Input size="sm" value={senders} placeholder="someone@example.com, example.org" onChange={(e) => setSenders(e.target.value)} />
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
      <div className="flex gap-2 flex-wrap">
        <ConfirmButton label={t.rotate} question={t.rotateConfirm} confirmClassName="btn pri sm" disabled={pending} onConfirm={() => toggle(true)} />
        <button type="button" className="btn sec sm" disabled={pending} onClick={() => toggle(false)}>
          {t.disable}
        </button>
      </div>
    </div>
  );
}

export function ChannelsSection({ agentId, channels }: { agentId: string; channels: ChannelSettings }) {
  const t = messages.channels;
  const on = channels.email.address ? 1 : 0;
  return (
    <PanelSection title={t.title} hint={channels.email.held.length && channels.email.unknown === "hold" ? `${t.summary(on)} · ${t.heldTitle(channels.email.held.length)}` : t.summary(on)} collapsible>
      <div className="flex flex-col gap-2">
        <span className="fld-label">{t.emailTitle}</span>
        <EmailChannel agentId={agentId} initial={channels.email} />
      </div>
    </PanelSection>
  );
}
