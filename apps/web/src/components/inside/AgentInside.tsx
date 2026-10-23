"use client";

import { cleanLook, type Look } from "@/lib/look";
import { ArrowLeft, ChevronDown, Monitor, PanelRight, Paperclip } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import type { Brain, AgentState } from "@understudy/protocol";
import { AgentFigure } from "@/components/AgentFigure";
import { useAgentSocket } from "@/components/live/useAgentSocket";
import { useSpeech } from "@/components/live/useSpeech";
import type { BrainStatus } from "@/lib/db/schema";
import { WORKSPACE_HIDDEN_COOKIE, chatRows } from "@/lib/chat-layout";
import { canApprove, canChat, canManage, type Access } from "@/lib/access-rules";
import { messages } from "@/lib/messages";
import { STATE_PILL } from "@/lib/state-pill";
import type { ApprovalView, ChatEntry } from "@/server/hub-types";
import { updateAgentLook } from "@/app/actions/agents";
import { CustomizeSheet } from "@/components/create/CustomizeSheet";
import { AgentCard } from "@/components/workspace/AgentCard";
import { AgentWorkspace, useWorkspaceFeeds, type OwnerData } from "@/components/workspace/AgentWorkspace";
import { ComputerPanel } from "@/components/workspace/ComputerPanel";
import { parseView, tabSearch, type AgentView } from "@/lib/workspace-tabs";
import { AgentRail, initials, type RailData } from "./AgentRail";
import { AgentSwitcher } from "./AgentSwitcher";
import { useVisualViewport } from "@/components/useVisualViewport";
import type { RunSummary, TaskSummary } from "@/components/workspace/TasksPanel";
import type { FollowupSummary } from "@/components/followups/FollowupList";
import { ARTIFACT_EVENT } from "@/components/artifacts/artifact-ui";
import { useAttachments } from "./useAttachments";
import { ApprovalCard, Composer, DayDivider, MessageRow, StepsGroup, StreamingRow, WorkingRow, useChatWidth } from "./ChatParts";
import { EmptyState } from "@/components/ui/EmptyState";

export { ApprovalCard };

const NARROW = "(max-width: 1000px)";

function useWorkspaceVisibility(initialHidden: boolean) {
  const [hidden, setHidden] = useState(initialHidden);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheetOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  const setVisible = useCallback((visible: boolean) => {
    if (window.matchMedia(NARROW).matches) {
      setSheetOpen(visible);
      return;
    }
    setHidden(!visible);
    try {
      document.cookie = `${WORKSPACE_HIDDEN_COOKIE}=${visible ? 0 : 1}; path=/; max-age=31536000; samesite=lax`;
    } catch {}
  }, []);

  const show = useCallback(() => setVisible(true), [setVisible]);
  const hide = useCallback(() => setVisible(false), [setVisible]);
  const toggle = useCallback(() => setVisible(window.matchMedia(NARROW).matches ? !sheetOpen : hidden), [setVisible, sheetOpen, hidden]);

  return { hidden, sheetOpen, visible: narrow ? sheetOpen : !hidden, show, hide, toggle };
}

function useAgentView(owner: boolean) {
  const pathname = usePathname();
  const params = useSearchParams();
  const view = parseView(params.get("tab"), owner);
  const hrefFor = useCallback((next: AgentView) => `${pathname}${tabSearch(params.toString(), next)}`, [pathname, params]);
  const select = useCallback(
    (next: AgentView) => {
      if (next !== view) window.history.pushState(null, "", hrefFor(next));
    },
    [view, hrefFor],
  );
  return { view, hrefFor, select };
}

const t = messages.live;

type AgentInfo = {
  id: string;
  name: string;
  role: string;
  look: Look;
  brain: Brain;
  state: AgentState;
  note: string | null;
  computerStatus: string;
  brains: BrainStatus[];
};

export function AgentInside({
  agent,
  ownerName,
  initialChat,
  initialApprovals,
  runs,
  recipes,
  followups = [],
  ownerData,
  rail,
  access = "owner",
  team = null,
  initialChatWidth = null,
  initialWorkspaceHidden = false,
}: {
  agent: AgentInfo;
  rail: RailData;
  ownerName: string;
  initialChat: ChatEntry[];
  initialApprovals: ApprovalView[];
  runs: RunSummary[];
  recipes: TaskSummary[];
  followups?: FollowupSummary[];
  ownerData: OwnerData | null;
  access?: Access;
  team?: { id: string; name: string } | null;
  initialChatWidth?: number | null;
  initialWorkspaceHidden?: boolean;
}) {
  const owner = canManage(access);
  const chatter = canChat(access);
  const [chat, setChat] = useState(initialChat);
  const [drafts, setDrafts] = useState<{ streamId: string; text: string }[]>([]);
  const [approvals, setApprovals] = useState(initialApprovals);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  const { live, send, subscribeFrames, listen } = useAgentSocket(
    agent.id,
    { state: agent.state, note: agent.note, computerStatus: agent.computerStatus, brains: agent.brains },
    {
      onChat: (entry) => {
        setChat((c) => (c.some((e) => e.id === entry.id) ? c : [...c, entry]));
        if (entry.artifact && entry.role === "agent") window.dispatchEvent(new Event(ARTIFACT_EVENT));
        if (entry.streamId) setDrafts((d) => d.filter((x) => x.streamId !== entry.streamId));
      },
      onChatDelta: (streamId, text) =>
        setDrafts((d) => (d.some((x) => x.streamId === streamId) ? d.map((x) => (x.streamId === streamId ? { streamId, text } : x)) : [...d, { streamId, text }])),
      onApproval: (approval) => setApprovals((a) => (a.some((x) => x.id === approval.id) ? a : [...a, approval])),
      onApprovalClosed: (id) => setApprovals((a) => a.filter((x) => x.id !== id)),
      onProposal: (proposal) => setChat((c) => c.map((e) => (e.proposal?.id === proposal.id ? { ...e, proposal } : e))),
      onRunFinished: () => router.refresh(),
    },
  );

  const speech = useSpeech((text) => setDraft((d) => (d ? `${d} ${text}` : text)));
  const attachments = useAttachments(agent.id);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);

  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  const dropProps = owner
    ? {
        onDragEnter(e: DragEvent) {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current++;
          setDropping(true);
        },
        onDragOver(e: DragEvent) {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        },
        onDragLeave(e: DragEvent) {
          if (!hasFiles(e)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDropping(false);
        },
        onDrop(e: DragEvent) {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDropping(false);
          attachments.add([...e.dataTransfer.files]);
        },
      }
    : {};

  const pinned = useRef(true);
  const [scrolled, setScrolled] = useState(false);
  const headRef = useRef<HTMLElement | null>(null);
  const [headHeight, setHeadHeight] = useState<number | null>(null);
  const { width, dragging, handleProps } = useChatWidth(initialChatWidth);
  const workspace = useWorkspaceVisibility(initialWorkspaceHidden);
  const full = owner && ownerData !== null;
  const { view, hrefFor, select } = useAgentView(full);
  const feeds = useWorkspaceFeeds(listen, ownerData);
  const [customizing, setCustomizing] = useState(false);
  const [switching, setSwitching] = useState(false);
  useVisualViewport();

  const open = useCallback(
    (next: AgentView) => {
      select(next);
      workspace.show();
    },
    [select, workspace.show],
  );

  async function saveLook(look: Look) {
    await updateAgentLook(agent.id, look);
    router.refresh();
  }

  useEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight });
  }, [chat.length, approvals.length, drafts, live.state]);

  useEffect(() => {
    const head = headRef.current;
    if (!head) return;
    const observer = new ResizeObserver(() => setHeadHeight(Math.round(head.getBoundingClientRect().height)));
    observer.observe(head);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTo({ top: el.scrollHeight });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const state: AgentState = approvals.length > 0 ? "waiting_you" : live.state;
  const brainName = messages.brains[agent.brain].name;

  function submit() {
    const text = draft.trim();
    const ready = attachments.ready;
    if ((!text && !ready.length) || attachments.uploading) return;
    if (send({ type: "chat", text, ...(ready.length ? { attachments: ready } : {}) })) {
      setDraft("");
      attachments.clear();
    }
  }

  const rows = useMemo(() => chatRows(chat), [chat]);
  const lastRow = rows[rows.length - 1];
  const working = live.online && state === "working";

  const wide = view !== "card";
  const computerShown = view === "computer" && workspace.visible;
  const agentRef = { id: agent.id, name: agent.name, look: agent.look };
  const accent = cleanLook(agent.look).color;
  const youInitials = initials(rail.userName) || "?";

  function side() {
    if (view === "card")
      return (
        <AgentCard
          agent={{ ...agentRef, role: agent.role }}
          link={{ live }}
          state={state}
          owner={owner}
          approvals={approvals.length}
          runs={runs}
          followups={followups}
          files={ownerData ? feeds.files : null}
          subscribeFrames={subscribeFrames}
          onOpen={open}
          onCustomize={owner ? () => setCustomizing(true) : null}
          onHide={workspace.hide}
        />
      );
    if (view === "computer")
      return (
        <ComputerPanel
          agent={agentRef}
          link={{ live, send }}
          state={state}
          owner={owner}
          ownerInitials={youInitials}
          subscribeFrames={subscribeFrames}
          onClose={() => {
            select("card");
            if (window.matchMedia(NARROW).matches) workspace.hide();
          }}
        />
      );
    return (
      <AgentWorkspace
        agent={agentRef}
        link={{ live, send, listen }}
        owner={owner}
        approvals={approvals.length}
        recipes={recipes}
        runs={runs}
        followups={followups}
        ownerData={ownerData}
        feeds={feeds}
        tab={view}
        hrefFor={hrefFor}
        onSelect={select}
        onBack={() => select("card")}
        onHide={workspace.hide}
      />
    );
  }

  return (
    <div
      className={`ap ${wide ? "is-wide" : "is-card"} ${dragging ? "is-resizing" : ""} ${workspace.hidden ? "ws-hidden" : ""} ${workspace.sheetOpen ? "ws-open" : ""}`}
      style={{ "--chat-w": `${width}px`, "--agent": accent } as CSSProperties}
    >
      <AgentRail data={rail} currentId={agent.id} current={{ state, note: live.note }} slim={wide && !workspace.hidden} />
      <section
        className={`cx-col ${dropping ? "is-dropping" : ""} ${scrolled ? "is-scrolled" : ""}`}
        style={headHeight ? ({ "--cx-head-h": `${headHeight}px` } as CSSProperties) : undefined}
        {...dropProps}
      >
        {dropping && (
          <div className="fx-drop" aria-hidden>
            <span className="fx-drop-icon">
              <Paperclip size={20} />
            </span>
            <strong>{messages.attachments.dropHere(agent.name)}</strong>
            <span>{messages.attachments.dropHint}</span>
          </div>
        )}
        <header ref={headRef} className="cx-head">
          <Link href="/" aria-label={messages.common.back} className="cx-back">
            <ArrowLeft size={17} aria-hidden />
          </Link>
          <AgentFigure state={state} size={34} look={agent.look} count={approvals.length} />
          <div className="min-w-0 flex-1">
            <h1 className="cx-title">
              <button type="button" className="cx-switch" aria-haspopup="dialog" aria-label={`${agent.name}, ${messages.agentPage.switchAgent}`} onClick={() => setSwitching(true)}>
                <span className="truncate">{agent.name}</span>
                <ChevronDown size={15} className="cx-switch-chev" aria-hidden />
              </button>
            </h1>
            <div className="cx-subtitle">
              <span className={`cx-state ${live.online ? STATE_PILL[state] : ""}`} aria-hidden />
              <span className="truncate">{team ? messages.teams.agentLine(team.name, ownerName.split(" ")[0], brainName) : t.ownerLine(ownerName.split(" ")[0], brainName)}</span>
            </div>
          </div>
          <button
            type="button"
            className={`cx-show-pc ${computerShown ? "is-on" : ""}`}
            aria-label={messages.agentPage.openComputer(agent.name)}
            title={messages.agentPage.openComputer(agent.name)}
            aria-pressed={computerShown}
            onClick={() => (computerShown ? select("card") : open("computer"))}
          >
            <Monitor size={16} strokeWidth={1.9} aria-hidden />
            <span className="cx-show-pc-label">{messages.workspace.tabs.computer}</span>
            <span className={`ws-live ${live.online ? "on" : ""}`} aria-hidden />
          </button>
          <button
            type="button"
            className="cx-show-ws"
            aria-label={workspace.visible ? messages.agentPage.hidePanel : messages.agentPage.showPanel}
            title={workspace.visible ? messages.agentPage.hidePanel : messages.agentPage.showPanel}
            aria-expanded={workspace.visible}
            aria-controls="agent-side"
            onClick={workspace.toggle}
          >
            <PanelRight size={16} strokeWidth={1.9} aria-hidden />
          </button>
        </header>
        <div
          ref={listRef}
          className="cx-list scroll-thin"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            setScrolled(el.scrollTop > 4);
          }}
        >
          {team && chatter && <p className="cx-team-note">{messages.teams.privateChat(agent.name, team.name)}</p>}
          {chat.length === 0 && approvals.length === 0 && drafts.length === 0 && (
            <EmptyState look={agent.look} mood="happy" title={messages.empty.chatTitle(agent.name)} body={messages.empty.chatBody} />
          )}
          {rows.map((row) => {
            if (row.kind === "day") return <DayDivider key={row.key} at={row.at} />;
            if (row.kind === "steps") return <StepsGroup key={row.key} entries={row.entries} active={working && row === lastRow && drafts.length === 0} />;
            return <MessageRow key={row.key} entry={row.entry} continued={row.continued} agentName={agent.name} look={agent.look} agentId={agent.id} onOpenArtifact={workspace.show} canAnswerProposal={owner} />;
          })}
          {drafts.map((d) => (
            <StreamingRow key={d.streamId} text={d.text} agentName={agent.name} look={agent.look} />
          ))}
          {working && drafts.length === 0 && approvals.length === 0 && <WorkingRow agentName={agent.name} look={agent.look} note={live.note} />}
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} canAnswer={Boolean(approval.forYou) || canApprove(access)} canGrant={access === "owner"} onDone={(id) => setApprovals((a) => a.filter((x) => x.id !== id))} />
          ))}
        </div>
        {chatter ? (
          <Composer agentName={agent.name} draft={draft} setDraft={setDraft} onSubmit={submit} speech={speech} attachments={owner ? attachments : undefined} />
        ) : (
          <p className="cx-readonly">{messages.agentPage.readOnly(ownerName.split(" ")[0], agent.name)}</p>
        )}
        {wide && <div className="cx-resize" {...handleProps} />}
      </section>

      <aside id="agent-side" className={`ap-side is-${view === "card" ? "card" : view === "computer" ? "computer" : "tabs"}`}>
        {side()}
      </aside>

      <AgentSwitcher open={switching} onClose={() => setSwitching(false)} data={rail} currentId={agent.id} current={{ state, note: live.note }} />
      {owner && <CustomizeSheet open={customizing} name={agent.name} look={agent.look} onSave={saveLook} onClose={() => setCustomizing(false)} />}
    </div>
  );
}
