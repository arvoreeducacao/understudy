import Link from "next/link";
import { useState } from "react";
import type { AgentState } from "@understudy/protocol";
import { ComputerScreen } from "@/components/live/ComputerScreen";
import type { AgentLink, Frame } from "@/components/live/useAgentSocket";
import type { Look } from "@/lib/look";
import { messages } from "@/lib/messages";
import { STATE_PILL } from "@/lib/state-pill";

const t = messages.live;

export function ComputerPanel({
  agent,
  link,
  state,
  owner,
  subscribeFrames,
}: {
  agent: { id: string; name: string; look: Look };
  link: Pick<AgentLink, "live" | "send">;
  state: AgentState;
  owner: boolean;
  subscribeFrames: (listener: (frame: Frame) => void) => () => void;
}) {
  const { live, send } = link;
  const [controlling, setControlling] = useState(false);

  const statusText = live.online
    ? `${messages.states[state]}${live.note ? ` · ${live.note}` : ""}`
    : live.computerStatus === "starting" || live.computerStatus === "pending"
      ? messages.home.computer[live.computerStatus]
      : t.offline;

  return (
    <div className="flex flex-col gap-2.5 h-full min-h-0">
      <div className="flex items-center gap-2.5 text-[12.5px] text-ash flex-wrap">
        <span className={`pill ${live.online ? STATE_PILL[state] : ""}`}>
          <span className="dot" />
          <span className="max-w-[320px] truncate">{statusText}</span>
        </span>
        <span className="truncate">{t.liveLabel(agent.name)}</span>
        <div className="ml-auto flex gap-2 flex-wrap">
          {owner && live.online && state === "working" && (
            <button className="btn sec" onClick={() => send({ type: "stop" })}>
              {t.stop}
            </button>
          )}
          {owner && (
            <button className={`btn ${controlling ? "warn" : "sec"}`} disabled={!live.online} onClick={() => setControlling((c) => !c)}>
              {controlling ? t.releaseControl : t.takeControl}
            </button>
          )}
          {owner && (
            <Link href={`/agents/${agent.id}/teach`} className="btn sec">
              {t.teach}
            </Link>
          )}
        </div>
      </div>
      {controlling && <div className="text-coral text-[12px]">{t.inControl}</div>}
      {live.error && <div className="err">{live.error}</div>}
      <ComputerScreen
        subscribeFrames={subscribeFrames}
        sendInput={(event) => send({ type: "input", event })}
        controlling={controlling && live.online}
        online={live.online}
        url={live.url}
        look={agent.look}
      />
    </div>
  );
}
