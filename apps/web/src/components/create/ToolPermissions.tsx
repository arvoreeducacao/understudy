import { Eye, TriangleAlert } from "lucide-react";
import { Segmented } from "@/components/ui/Segmented";
import { messages } from "@/lib/messages";
import {
  allowReadOnly,
  allowedChoices,
  askForRest,
  ceilingFor,
  effectivePermission,
  isDestructive,
  isReadOnly,
  withChoice,
  type ConnectorCeiling,
  type ToolInfo,
  type ToolPermission,
} from "@/lib/tool-policy";

export function ToolPermissions({
  serverId,
  serverName,
  tools,
  ceiling,
  policy,
  onChange,
}: {
  serverId: string;
  serverName: string;
  tools: ToolInfo[];
  ceiling: ConnectorCeiling;
  policy: Record<string, ToolPermission>;
  onChange: (next: Record<string, ToolPermission>) => void;
}) {
  const t = messages.toolAccess;
  const readOnly = tools.filter((tool) => isReadOnly(tool.annotations));
  const rest = tools.filter((tool) => !isReadOnly(tool.annotations));
  const permissionOf = (tool: ToolInfo) => effectivePermission({ serverId, server: ceiling, tool, policy: { [serverId]: policy } }).permission;
  const counts = { allow: 0, ask: 0, never: 0 };
  for (const tool of tools) counts[permissionOf(tool)] += 1;

  return (
    <div className="tp">
      <div className="tp-head">
        <span className="tp-counts">{t.counts(counts.allow, counts.ask, counts.never)}</span>
        <div className="tp-bulk">
          <button type="button" className="btn sec sm" disabled={readOnly.length === 0} onClick={() => onChange(allowReadOnly(policy, readOnly))}>
            {t.allowReadOnly}
          </button>
          <button type="button" className="btn sec sm" disabled={rest.length === 0} onClick={() => onChange(askForRest(policy, rest))}>
            {t.askForRest}
          </button>
        </div>
      </div>
      {ceiling.askAll && <p className="fld-hint m-0">{t.adminAsksAll}</p>}
      <ul className="tp-list" aria-label={t.listLabel(serverName)}>
        {tools.map((tool) => {
          const cap = ceilingFor(ceiling, tool.name);
          const current = permissionOf(tool);
          const choices = allowedChoices(cap);
          const destructive = isDestructive(tool.annotations);
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
                  {destructive && (
                    <span className="tp-tag is-danger">
                      <TriangleAlert size={12} aria-hidden />
                      {t.destructive}
                    </span>
                  )}
                </div>
                {tool.description && <p className="tp-desc">{tool.description}</p>}
                {cap !== "allow" && <p className="tp-lock">{cap === "never" ? t.adminBlocked : t.adminAtMostAsk}</p>}
              </div>
              <Segmented
                className="tp-seg"
                label={t.choiceLabel(tool.name)}
                options={choices.map((value) => ({ value, label: t.permission[value] }))}
                value={current}
                disabled={choices.length === 1}
                onChange={(value) => onChange(withChoice(policy, tool, value))}
              />
            </li>
          );
        })}
      </ul>
      <p className="fld-hint m-0">{t.newToolsHint}</p>
    </div>
  );
}
