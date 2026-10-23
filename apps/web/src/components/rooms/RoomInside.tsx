"use client";

import { ArrowLeft, MessageCircle, Plus, ShieldCheck, Square, UsersRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentState } from "@understudy/protocol";
import { answerApproval } from "@/app/actions/approvals";
import { addToRoom, removeRoom } from "@/app/actions/rooms";
import { AgentFigure } from "@/components/AgentFigure";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Composer, DayDivider, MessageRow, StreamingRow, WorkingRow } from "@/components/inside/ChatParts";
import { useSpeech } from "@/components/live/useSpeech";
import type { Look } from "@/lib/look";
import { messages, messagesFor, type Messages } from "@/lib/messages";
import { MentionHandles, MentionText } from "@/components/inside/Markdown";
import { findMentions, mentionHandles, mentionsEveryone, mightBePass, roomRows, shownText } from "@/lib/rooms";
import { Select } from "@/components/ui/Select";
import type { ChatEntry, RoomEntry, RoomPresence } from "@/server/hub-types";
import { useRoomSocket } from "./useRoomSocket";

export type RoomMemberView = { id: string; name: string; role: string; look: Look; state: AgentState; online: boolean };

type Draft = { agentId: string; streamId: string; text: string };

type Person = { id: string; name: string };

function asChat(entry: RoomEntry, words: Messages): ChatEntry {
  return { id: entry.id, role: entry.author === "owner" || entry.author === "person" ? "user" : entry.author === "agent" ? "agent" : "system", text: shownText(words, entry), at: entry.at };
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function PersonRow({ entry, name, continued }: { entry: RoomEntry; name: string; continued: boolean }) {
  return (
    <div className={`cx-agent ${continued ? "is-continued" : ""}`}>
      <div className="cx-avatar">{!continued && <span className="tm-av sm">{initials(name)}</span>}</div>
      <div className="cx-agent-body">
        {!continued && (
          <div className="cx-meta" suppressHydrationWarning>
            <span className="cx-name">{name}</span>
            <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          </div>
        )}
        <div className="rm-person-bubble">
          <MentionText text={entry.text} />
        </div>
      </div>
    </div>
  );
}

function ApprovalRow({ entry, agentName, look, asker, mine, status }: { entry: RoomEntry; agentName: string; look: Look; asker: string; mine: boolean; status: string }) {
  const t = messages.rooms;
  const [state, setState] = useState(status);
  const [busy, setBusy] = useState(false);
  const answer = async (approved: boolean) => {
    if (!entry.approvalId) return;
    setBusy(true);
    const result = await answerApproval(entry.approvalId, approved);
    setBusy(false);
    if (result.ok || result.status) setState(result.status ?? state);
  };
  return (
    <div className="cx-agent">
      <div className="cx-avatar">
        <AgentFigure size={22} look={look} live={false} />
      </div>
      <div className="cx-agent-body">
        <div className="rm-approval">
          <div className="rm-approval-title">
            <ShieldCheck size={15} aria-hidden />
            {entry.text}
          </div>
          <div className="rm-approval-who">{state === "pending" ? (mine ? t.approvalMine(agentName) : t.approvalWaiting(asker)) : t.approvalDone(messages.approvals.status[state] ?? state)}</div>
          {mine && state === "pending" && (
            <div className="flex gap-2 flex-wrap">
              <button type="button" className="btn pri sm" disabled={busy} onClick={() => answer(true)}>
                {t.approve}
              </button>
              <a className="btn sec sm no-underline" href="/waiting">
                {t.seeDetails}
              </a>
              <button type="button" className="btn sec sm" disabled={busy} onClick={() => answer(false)}>
                {t.deny}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function merge(list: RoomEntry[], incoming: RoomEntry[]) {
  const known = new Set(list.map((entry) => entry.id));
  const fresh = incoming.filter((entry) => !known.has(entry.id));
  if (!fresh.length) return list;
  return [...list, ...fresh].sort((a, b) => a.at.localeCompare(b.at));
}

export function RoomInside({
  room,
  members,
  initial,
  ceiling,
  me = "",
  team = null,
  people = [],
  approvals = {},
  addable = { agents: [], people: [] },
  canDelete = true,
}: {
  room: { id: string; name: string };
  members: RoomMemberView[];
  initial: RoomEntry[];
  ceiling: number | null;
  me?: string;
  team?: { id: string; name: string; language?: string } | null;
  people?: Person[];
  approvals?: Record<string, string>;
  addable?: { agents: Person[]; people: Person[] };
  canDelete?: boolean;
}) {
  const t = messages.rooms;
  const router = useRouter();
  const [entries, setEntries] = useState(initial);
  const [statuses, setStatuses] = useState(approvals);
  const [adding, setAdding] = useState("");
  const personName = useMemo(() => new Map(people.map((person) => [person.id, person.name])), [people]);
  const words = useMemo(() => messagesFor(team?.language), [team?.language]);
  const handles = useMemo(() => mentionHandles([...members, ...people].map((who) => who.name)), [members, people]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [presence, setPresence] = useState<Record<string, RoomPresence>>(() =>
    Object.fromEntries(members.map((member) => [member.id, { agentId: member.id, working: false, note: null, online: member.online }])),
  );
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const byId = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

  const { connected, error, send } = useRoomSocket(room.id, {
    onEntries: (incoming) => {
      setEntries((list) => merge(list, incoming));
      const speakers = new Set(incoming.filter((entry) => entry.author === "agent").map((entry) => entry.agentId));
      if (speakers.size) setDrafts((list) => list.filter((d) => !speakers.has(d.agentId)));
    },
    onDelta: (agentId, streamId, text) =>
      setDrafts((list) => (list.some((d) => d.streamId === streamId) ? list.map((d) => (d.streamId === streamId ? { ...d, text } : d)) : [...list, { agentId, streamId, text }])),
    onApproval: (approvalId, status) => setStatuses((current) => ({ ...current, [approvalId]: status })),
    onPresence: (list) => {
      setPresence((current) => ({ ...current, ...Object.fromEntries(list.map((p) => [p.agentId, p])) }));
      const idle = new Set(list.filter((p) => !p.working).map((p) => p.agentId));
      if (idle.size) setDrafts((d) => d.filter((x) => !idle.has(x.agentId)));
    },
  });

  const speech = useSpeech((text) => setDraft((d) => (d ? `${d} ${text}` : text)));

  const visibleDrafts = drafts.filter((d) => !mightBePass(d.text));
  const working = members.filter((member) => presence[member.id]?.working && !visibleDrafts.some((d) => d.agentId === member.id));

  useEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight });
  }, [entries.length, drafts, working.length]);

  const rows = useMemo(() => roomRows(entries), [entries]);
  const addressed = useMemo(() => findMentions(draft, members), [draft, members]);
  const toEveryone = team ? mentionsEveryone(draft) : addressed.length === 0 || mentionsEveryone(draft);
  const toNobody = Boolean(team) && addressed.length === 0 && !mentionsEveryone(draft);

  function submit() {
    const text = draft.trim();
    if (!text) return;
    if (send({ type: "chat", text })) setDraft("");
  }

  function address(member: RoomMemberView | null) {
    const strip = (text: string, names: string[]) =>
      names.reduce((value, name) => value.replace(new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s?`, "giu"), ""), text).trimStart();
    setDraft((current) => {
      if (!member) return strip(current, members.map((m) => m.name));
      if (findMentions(current, [member]).length) return strip(current, [member.name]);
      return `@${member.name} ${current}`;
    });
  }

  const busy = working.length > 0 || visibleDrafts.length > 0 || members.some((member) => presence[member.id]?.working);

  function stop() {
    if (send({ type: "stop" })) setDrafts([]);
  }

  const stateOf = (member: RoomMemberView): AgentState => (presence[member.id]?.working ? "working" : member.state === "waiting_you" ? "waiting_you" : "calm");

  return (
    <div className="rm-layout">
      <section className="cx-col rm-col" aria-label={room.name}>
        <header className="cx-head">
          <Link href="/rooms" aria-label={messages.common.back} className="cx-back">
            <ArrowLeft size={17} aria-hidden />
          </Link>
          <span className="rm-stack" aria-hidden>
            {members.slice(0, 4).map((member) => (
              <span key={member.id} className="rm-stack-item">
                <AgentFigure size={30} look={member.look} state={stateOf(member)} />
              </span>
            ))}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="cx-title">{room.name}</h1>
            <div className="cx-subtitle">
              <span className={`cx-state ${connected ? "g" : ""}`} aria-hidden />
              <span className="truncate">{team ? t.teamSubtitle(team.name, people.length, members.map((member) => member.name).join(", ")) : members.map((member) => member.name).join(", ")}</span>
            </div>
          </div>
          <button type="button" className="rm-stop" onClick={stop} disabled={!busy || !connected} title={t.stopRoomHint}>
            <Square size={12} fill="currentColor" aria-hidden />
            {t.stop}
          </button>
        </header>
        <div
          ref={listRef}
          className="cx-list scroll-thin"
          aria-live="polite"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {entries.length === 0 && drafts.length === 0 && working.length === 0 && (
            <div className="cx-empty">
              <span className="rm-stack" aria-hidden>
                {members.slice(0, 4).map((member) => (
                  <span key={member.id} className="rm-stack-item">
                    <AgentFigure size={48} look={member.look} />
                  </span>
                ))}
              </span>
              <p>{team ? t.emptyTeamRoom : t.emptyRoom}</p>
            </div>
          )}
          <MentionHandles.Provider value={handles}>
            {rows.map((row) => {
              if (row.kind === "day") return <DayDivider key={row.key} at={row.at} />;
              const member = row.entry.agentId ? byId.get(row.entry.agentId) : undefined;
              if (row.entry.approvalId) {
                return (
                  <ApprovalRow
                    key={`${row.key}-${statuses[row.entry.approvalId] ?? "pending"}`}
                    entry={row.entry}
                    agentName={member?.name ?? t.someoneWhoLeft}
                    look={member?.look ?? ({} as Look)}
                    asker={personName.get(row.entry.userId ?? "") ?? t.someoneWhoLeft}
                    mine={row.entry.userId === me}
                    status={statuses[row.entry.approvalId] ?? "pending"}
                  />
                );
              }
              if (row.entry.author === "person" && row.entry.userId !== me) {
                return <PersonRow key={row.key} entry={row.entry} name={personName.get(row.entry.userId ?? "") ?? t.someoneWhoLeft} continued={row.continued} />;
              }
              return (
                <MessageRow
                  key={row.key}
                  entry={asChat(row.entry, words)}
                  continued={row.continued}
                  agentName={member?.name ?? t.someoneWhoLeft}
                  look={member?.look ?? ({} as Look)}
                  footer={
                    row.entry.runId && row.entry.author === "agent" ? (
                      <div className="rm-run-link">
                        <Link href={`/runs/${row.entry.runId}`} className="text-sky">
                          {t.openRun}
                        </Link>
                      </div>
                    ) : undefined
                  }
                />
              );
            })}
          </MentionHandles.Provider>
          {visibleDrafts.map((d) => {
            const member = byId.get(d.agentId);
            return member ? <StreamingRow key={d.streamId} text={d.text} agentName={member.name} look={member.look} /> : null;
          })}
          {working.map((member) => (
            <WorkingRow key={member.id} agentName={member.name} look={member.look} note={presence[member.id]?.note ?? null} />
          ))}
        </div>
        {error && <div className="err mx-3">{error}</div>}
        <div className="rm-talkto" role="group" aria-label={t.talkTo}>
          <span className="rm-talkto-label">{t.talkTo}</span>
          {!team && (
            <button type="button" className="rm-chip" aria-pressed={toEveryone} onClick={() => address(null)}>
              <UsersRound size={13} aria-hidden />
              {t.everyone}
            </button>
          )}
          {members.map((member) => (
            <button key={member.id} type="button" className="rm-chip" aria-pressed={!toEveryone && addressed.includes(member.id)} onClick={() => address(member)}>
              <AgentFigure size={16} look={member.look} live={false} />
              {member.name}
            </button>
          ))}
        </div>
        {toNobody && draft.trim() && <p className="rm-nobody">{t.nobodyWakes}</p>}
        <Composer agentName={t.composerName(room.name)} draft={draft} setDraft={setDraft} onSubmit={submit} speech={speech} />
      </section>

      <aside className="rm-side" aria-label={t.participants}>
        <h2 className="rm-side-title">{t.participants}</h2>
        <ul className="rm-people">
          {members.map((member) => {
            const p = presence[member.id];
            const status = !p?.online && !p?.working ? t.offline : p?.working ? (p.note ?? t.working) : t.idle;
            return (
              <li key={member.id} className="rm-person">
                <AgentFigure size={52} look={member.look} state={stateOf(member)} />
                <div className="min-w-0 flex-1">
                  <div className="rm-person-name">{member.name}</div>
                  {member.role && <div className="rm-person-role">{member.role}</div>}
                  <div className={`rm-person-status ${p?.working ? "is-working" : ""}`}>
                    <span className={`cx-state ${p?.working ? "s" : p?.online ? "g" : ""}`} aria-hidden />
                    <span className="truncate">{status}</span>
                  </div>
                </div>
                <Link href={`/agents/${member.id}`} className="cx-back" aria-label={`${t.openChat}: ${member.name}`} title={t.openChat}>
                  <MessageCircle size={16} aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
        {team && (
          <>
            <h2 className="rm-side-title mt-4">{t.peopleTitle}</h2>
            <ul className="rm-people">
              {people.map((person) => (
                <li key={person.id} className="rm-person">
                  <span className="tm-av" aria-hidden>
                    {initials(person.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="rm-person-name">{person.name}</div>
                    {person.id === me && <div className="rm-person-role">{messages.teams.you}</div>}
                  </div>
                </li>
              ))}
            </ul>
            {addable.agents.length + addable.people.length > 0 && (
              <div className="flex gap-2 items-center mt-2">
                <Select
                  className="flex-1"
                  aria-label={t.addLabel}
                  value={adding}
                  onChange={setAdding}
                  options={[
                    ...addable.agents.map((agent) => ({ value: `a:${agent.id}`, label: agent.name, description: t.addAgentKind })),
                    ...addable.people.map((person) => ({ value: `p:${person.id}`, label: person.name, description: t.addPersonKind })),
                  ]}
                  placeholder={t.addLabel}
                />
                <button
                  type="button"
                  className="btn sec sm"
                  disabled={!adding}
                  aria-label={t.add}
                  onClick={async () => {
                    const [kind, id] = [adding.slice(0, 1), adding.slice(2)];
                    const result = await addToRoom(room.id, kind === "a" ? { agentIds: [id] } : { peopleIds: [id] });
                    if (result.ok) {
                      setAdding("");
                      router.refresh();
                    }
                  }}
                >
                  <Plus size={14} aria-hidden />
                </button>
              </div>
            )}
          </>
        )}
        <p className="rm-side-note">{team ? t.teamMentionHint : t.mentionHint}</p>
        {!team && <p className="rm-side-note">{t.talkNote(ceiling)}</p>}
        {canDelete && (
          <div className="mt-auto pt-3">
            <ConfirmButton
              label={t.deleteRoom}
              question={t.deleteConfirm}
              onConfirm={async () => {
                const result = await removeRoom(room.id);
                if (result.ok) router.push("/rooms");
              }}
            />
          </div>
        )}
      </aside>
    </div>
  );
}
