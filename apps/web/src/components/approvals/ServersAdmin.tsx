"use client";

import { ChevronRight, Eye, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { checkMcpServer, removeMcpServer, setServerAccess } from "@/app/actions/servers";
import { setConnectorCeiling } from "@/app/actions/tool-limits";
import { isDestructive, isReadOnly, type ToolInfo } from "@/lib/tool-policy";
import { featuredFor } from "@/lib/connector-showcase";
import { messages } from "@/lib/messages";
import { Checkbox, Input } from "@/components/ui/controls";
import { Segmented } from "@/components/ui/Segmented";
import { ConnectorLogo, ConnectorShowcase } from "./ConnectorShowcase";

type ServerRow = { id: string; name: string; url: string; tools: string[] | null; askAll: boolean; askTools: string[]; allowedEmails: string[] | null };

type Ceiling = "owner" | "ask" | "never";

function CeilingRules({ server, tools, limits }: { server: ServerRow; tools: ToolInfo[] | null; limits: { ask: string[]; never: string[] } }) {
  const t = messages.toolAccess;
  const [askAll, setAskAll] = useState(server.askAll);
  const [levels, setLevels] = useState<Record<string, Ceiling>>(() => {
    const start: Record<string, Ceiling> = {};
    for (const tool of [...server.askTools, ...limits.ask]) start[tool] = "ask";
    for (const tool of limits.never) start[tool] = "never";
    return start;
  });
  const [saved, setSaved] = useState(false);
  const [, start] = useTransition();
  const save = (all: boolean, next: Record<string, Ceiling>) =>
    start(async () => {
      const entries = Object.entries(next);
      await setConnectorCeiling(server.id, { askAll: all, ask: entries.filter(([, level]) => level === "ask").map(([tool]) => tool), never: entries.filter(([, level]) => level === "never").map(([tool]) => tool) });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });
  return (
    <div className="flex flex-col gap-3 text-[12.5px]">
      <div className="flex flex-col gap-1">
        <span className="fld-label">{t.ceilingTitle}</span>
        <span className="fld-hint">{t.ceilingHint}</span>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Checkbox
          className="!text-[12.5px]"
          checked={askAll}
          onChange={(e) => {
            setAskAll(e.target.checked);
            save(e.target.checked, levels);
          }}
          label={t.ceilingAskAll}
        />
        {saved && <span className="text-green">{messages.admin.serverSaved}</span>}
      </div>
      {tools && tools.length > 0 && (
        <ul className="tp-list" aria-label={t.ceilingTitle}>
          {tools.map((tool) => {
            const level = levels[tool.name] ?? "owner";
            const options = (askAll ? (["ask", "never"] as Ceiling[]) : (["owner", "ask", "never"] as Ceiling[])).map((value) => ({ value, label: t.ceiling[value] }));
            return (
              <li key={tool.name} className="tp-row">
                <div className="tp-tool">
                  <div className="tp-name">
                    <span className="font-mono">{tool.name}</span>
                    {isReadOnly(tool.annotations) && (
                      <span className="tp-tag">
                        <Eye size={12} aria-hidden />
                        {t.readOnly}
                      </span>
                    )}
                    {isDestructive(tool.annotations) && (
                      <span className="tp-tag is-danger">
                        <TriangleAlert size={12} aria-hidden />
                        {t.destructive}
                      </span>
                    )}
                  </div>
                  {tool.description && <p className="tp-desc">{tool.description}</p>}
                </div>
                <Segmented
                  className="tp-seg"
                  label={t.ceilingChoiceLabel(tool.name)}
                  options={options}
                  value={askAll && level === "owner" ? "ask" : level}
                  onChange={(value) => {
                    const next = { ...levels };
                    if (value === "owner") delete next[tool.name];
                    else next[tool.name] = value;
                    setLevels(next);
                    save(askAll, next);
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AccessRules({ server, everyoneAllowed }: { server: ServerRow; everyoneAllowed: boolean }) {
  const t = messages.admin;
  const [everyone, setEveryone] = useState(server.allowedEmails === null);
  const [emails, setEmails] = useState((server.allowedEmails ?? []).join(", "));
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const save = (all: boolean, list: string) =>
    start(async () => {
      await setServerAccess(server.id, all, list);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });
  return (
    <div className="flex flex-col gap-2 text-[12.5px]">
      <div className="flex gap-3 flex-wrap items-center">
        {everyoneAllowed ? (
        <Segmented
          label={t.serverAccess}
          options={[
            { value: "all", label: t.serverEveryone },
            { value: "some", label: t.serverOnly },
          ]}
          value={everyone ? "all" : "some"}
          onChange={(choice) => {
            if (choice === "all") {
              setEveryone(true);
              save(true, emails);
            } else setEveryone(false);
          }}
        />
        ) : (
          <span className="fld-hint">{t.serverOnlyYou}</span>
        )}
        {saved && <span className="text-green">{t.serverSaved}</span>}
      </div>
      {!everyone && (
        <div className="flex gap-2">
          <Input size="sm" placeholder={t.serverEmails} aria-label={t.serverEmails} value={emails} onChange={(e) => setEmails(e.target.value)} />
          <button type="button" className="btn sec sm" disabled={pending} onClick={() => save(false, emails)}>
            {t.serverSave}
          </button>
        </div>
      )}
    </div>
  );
}

function CheckAgain({ id }: { id: string }) {
  const t = messages.admin;
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      {result && <span className={`text-[12px] ${result.ok ? "text-green" : "text-coral"}`}>{result.message}</span>}
      <button type="button" className="btn sec sm" disabled={pending} onClick={() => start(async () => setResult(await checkMcpServer(id)))}>
        {pending ? t.serverChecking : t.serverCheck}
      </button>
    </>
  );
}

export function ConnectedActions({ id, removable }: { id: string; removable: boolean }) {
  const t = messages.admin;
  const router = useRouter();
  const [removing, startRemove] = useTransition();
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <CheckAgain id={id} />
      {removable && (
      <button
        type="button"
        className="btn sec sm"
        disabled={removing}
        onClick={() =>
          startRemove(async () => {
            await removeMcpServer(id);
            router.push("/connectors");
          })
        }
      >
        {t.serverRemove}
      </button>
      )}
    </div>
  );
}

export function ConnectorSettings({ server, tools, limits, everyoneAllowed }: { server: ServerRow; tools: ToolInfo[] | null; limits: { ask: string[]; never: string[] }; everyoneAllowed: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <AccessRules server={server} everyoneAllowed={everyoneAllowed} />
      <CeilingRules server={server} tools={tools} limits={limits} />
    </div>
  );
}

export function ConnectorActionsList({ tools }: { tools: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tools.map((tool) => (
        <span key={tool} className="pill font-mono">
          {tool}
        </span>
      ))}
    </div>
  );
}

function ConnectedCard({ server }: { server: ServerRow }) {
  const t = messages.admin;
  const known = featuredFor(server.url);
  const down = server.tools === null;
  let host = server.url;
  try {
    host = new URL(server.url).host;
  } catch {}
  return (
    <li>
      <Link href={`/connectors/${known?.id ?? server.id}`} className="conn-card conn-card-link">
        <ConnectorLogo connector={known ?? { name: server.name, url: server.url, publisher: { kind: "domain", label: host } }} />
        <span className="min-w-0 flex-1">
          <span className="conn-name">{server.name}</span>
          <span className="conn-by">{host}</span>
        </span>
        <span className={`pill ${down ? "c" : "g"}`}>{down ? t.connectedDown : t.connectedWorks(server.tools?.length ?? 0)}</span>
        <ChevronRight size={16} className="text-smoke flex-none" aria-hidden />
      </Link>
    </li>
  );
}

export type { ServerRow };

export function ServersAdmin({ servers }: { servers: ServerRow[] }) {
  const t = messages.admin;
  return (
    <section id="connected-tools" className="card p-5 flex flex-col gap-5 scroll-mt-6">
      {servers.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <h3 className="m-0 text-[14px] font-semibold">{t.connectedTitle(servers.length)}</h3>
          <ul className="conn-list" aria-label={t.connectedTitle(servers.length)}>
            {servers.map((server) => (
              <ConnectedCard key={server.id} server={server} />
            ))}
          </ul>
        </div>
      )}
      <ConnectorShowcase connectedUrls={servers.map((server) => server.url)} />
    </section>
  );
}
