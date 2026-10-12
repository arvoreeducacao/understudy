import { Eye, RefreshCw, TriangleAlert } from "lucide-react";
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
  seenHintsFor,
  trustedHints,
  withChoice,
  type ConnectorCeiling,
  type SeenHints,
  type ToolInfo,
  type ToolPermission,
} from "@/lib/tool-policy";

export function ToolPermissions({
  serverId,
  serverName,
  tools,
  ceiling,
  seen,
  policy,
  onChange,
}: {
  serverId: string;
  serverName: string;
  tools: ToolInfo[];
  ceiling: ConnectorCeiling;
  seen?: SeenHints;
  policy: Record<string, ToolPermission>;
  onChange: (next: Record<string, ToolPermission>) => void;
}) {
  const t = messages.toolAccess;
  const seenOf = (tool: ToolInfo) => seenHintsFor(seen, serverId, tool.name);
  const hintsOf = (tool: ToolInfo) => trustedHints(seenOf(tool), tool.annotations);
  const trusted = tools.map((tool) => ({ ...tool, annotations: hintsOf(tool) }));
  const readOnly = trusted.filter((tool) => isReadOnly(tool.annotations));
  const rest = trusted.filter((tool) => !isReadOnly(tool.annotations));
  const verdictOf = (tool: ToolInfo) => effectivePermission({ serverId, server: ceiling, tool, policy: { [serverId]: policy }, seen });
  const permissionOf = (tool: ToolInfo) => verdictOf(tool).permission;
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
          const hints = hintsOf(tool);
          const destructive = isDestructive(hints);
          const changed = verdictOf(tool).changed;
          return (
            <li key={tool.name} className="tp-row">
              <div className="tp-tool">
                <div className="tp-name">
                  <span className="font-mono">{tool.name}</span>
                  {isReadOnly(hints) && (
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
                  {changed && (
                    <span className="tp-tag is-danger" title={changed === "new" ? t.hintsNewHint : changed === "riskier" ? t.hintsRiskierHint : t.hintsChangedHint}>
                      <RefreshCw size={12} aria-hidden />
                      {changed === "new" ? t.hintsNew : t.hintsChanged}
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
