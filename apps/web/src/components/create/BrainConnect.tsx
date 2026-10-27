"use client";

import { useState, useTransition } from "react";
import type { Brain } from "@understudy/protocol";
import { setAgentBrainAccount } from "@/app/actions/agents";
import { BrainKeyForm } from "@/components/BrainKeyForm";
import type { LiveState } from "@/components/live/useAgentSocket";
import type { BrainAccountView } from "@/lib/brain-account";
import { messages } from "@/lib/messages";
import type { ViewerToServer } from "@/server/hub-types";
import { Input } from "@/components/ui/controls";

const t = messages.brains;
const k = messages.brainAccount;

export type BrainKey = { agentId: string; saved: BrainAccountView | null; onChange: (account: BrainAccountView | null) => void };

function keyHost(url: string | null) {
  if (!url) return k.anthropic;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function BrainConnect({
  live,
  send,
  current,
  onSelect,
  claudeKey,
}: {
  live: LiveState;
  send: (message: ViewerToServer) => boolean;
  current: Brain;
  onSelect: (brain: Brain) => void;
  claudeKey?: BrainKey;
}) {
  const [connecting, setConnecting] = useState<Brain | null>(null);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [removing, startRemoving] = useTransition();
  const prompt = live.loginPrompt;
  const safeUrl = prompt?.url && /^https:\/\//i.test(prompt.url) ? prompt.url : null;
  const result = live.loginResult;

  function connect(brain: Brain) {
    setConnecting(brain);
    setCode("");
    setCopied(false);
    send({ type: "login_start", brain });
  }

  function submitCode(brain: Brain) {
    if (!code.trim()) return;
    send({ type: "login_code", brain, code: code.trim() });
    setCode("");
  }

  function dropKey() {
    if (!claudeKey) return;
    startRemoving(async () => {
      const removed = await setAgentBrainAccount(claudeKey.agentId, { own: false });
      if (removed.ok) claudeKey.onChange(null);
    });
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-2.5 max-[600px]:grid-cols-1">
        {(["claude", "codex"] as Brain[]).filter((brain) => brain === "claude" || live.brains.some((b) => b.brain === "codex")).map((brain) => {
          const status = live.brains.find((b) => b.brain === brain);
          const offersKey = brain === "claude" && Boolean(claudeKey);
          const savedKey = offersKey ? (claudeKey?.saved ?? null) : null;
          const formOpen = offersKey && keyOpen;
          const loggedIn = Boolean(savedKey) || Boolean(status?.loggedIn);
          const selected = current === brain;
          const isConnecting = connecting === brain && !result;
          const plan = savedKey
            ? k.summary(keyHost(savedKey.url), savedKey.last4, savedKey.maxUsdPerTurn)
            : offersKey && !status?.loggedIn
              ? k.either
              : `${t[brain].plan}${status?.account ? ` · ${t.connectedAs(status.account)}` : ""}`;
          const useThis = (
            <button
              type="button"
              className="pill cursor-pointer"
              onClick={() => {
                send({ type: "set_brain", brain });
                onSelect(brain);
              }}
            >
              {t.use}
            </button>
          );
          return (
            <div
              key={brain}
              className={`rounded-xl p-3.5 text-[13px] flex flex-col gap-1.5 bg-obsidian border ${selected && loggedIn ? "border-green" : "border-line"} ${formOpen ? "col-span-2 max-[600px]:col-span-1" : ""}`}
            >
              <b className="font-semibold">{t[brain].name}</b>
              <span className="text-[11.5px] text-smoke">{plan}</span>
              <div className="flex gap-2 flex-wrap mt-1">
                {savedKey ? (
                  <>
                    {selected ? (
                      <span className="pill g">
                        <span className="dot" />
                        {t.inUse}
                      </span>
                    ) : (
                      useThis
                    )}
                    <button type="button" className="pill cursor-pointer" aria-pressed={formOpen} onClick={() => setKeyOpen(!keyOpen)}>
                      {k.changeKey}
                    </button>
                    <button type="button" className="pill cursor-pointer" disabled={removing} onClick={dropKey}>
                      {k.connectInstead}
                    </button>
                  </>
                ) : (
                  <>
                    {loggedIn ? (
                      <span className="pill g">
                        <span className="dot" />
                        {t.connected}
                      </span>
                    ) : (
                      <button type="button" className="pill cursor-pointer" disabled={!live.online || isConnecting} onClick={() => connect(brain)}>
                        {isConnecting ? t.connecting : t.connect}
                      </button>
                    )}
                    {loggedIn && (selected ? <span className="pill">{t.inUse}</span> : useThis)}
                    {offersKey && (
                      <button type="button" className="pill cursor-pointer" aria-pressed={formOpen} onClick={() => setKeyOpen(!keyOpen)}>
                        {loggedIn ? k.useKeyInstead : k.useKey}
                      </button>
                    )}
                  </>
                )}
              </div>
              {formOpen && claudeKey && (
                <div className="mt-2 pt-3 border-t border-line">
                  <BrainKeyForm
                    agentId={claudeKey.agentId}
                    saved={claudeKey.saved}
                    onSaved={(account) => {
                      claudeKey.onChange(account);
                      setKeyOpen(false);
                    }}
                    onCancel={() => setKeyOpen(false)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!live.online && !claudeKey?.saved && <div className="text-[12px] text-smoke">{t.waitComputer}</div>}
      {prompt && (
        <div className="bg-graphite rounded-[10px] px-3.5 py-3 flex flex-col gap-2.5 text-[13px]">
          <div className="flex justify-between items-center gap-3 flex-wrap">
            {safeUrl ? (
              <div className="flex gap-2 flex-wrap">
                <a href={safeUrl} target="_blank" rel="noreferrer noopener" className="btn pri sm">
                  {t.openSignIn}
                </a>
                <button
                  type="button"
                  className="btn sec sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(safeUrl).then(() => setCopied(true), () => undefined);
                  }}
                >
                  {copied ? t.linkCopied : t.copyLink}
                </button>
              </div>
            ) : (
              <span>{prompt.message}</span>
            )}
            {prompt.code && <b className="font-mono tracking-[.12em] text-[15px]">{prompt.code}</b>}
          </div>
          {safeUrl && prompt.message && <div className="text-smoke text-[12px]">{prompt.message}</div>}
          {!prompt.code && (
            <div className="flex gap-2">
              <Input
                placeholder={t.pasteCode}
                aria-label={t.pasteCode}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitCode(prompt.brain);
                  }
                }}
              />
              <button type="button" className="btn sec" onClick={() => submitCode(prompt.brain)}>
                {t.sendCode}
              </button>
            </div>
          )}
        </div>
      )}
      {result && !result.ok && <div className="err">{result.message || t.loginFailed}</div>}
    </div>
  );
}
