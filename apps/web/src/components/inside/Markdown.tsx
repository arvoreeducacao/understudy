import { Check, Copy } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { chartScene, COMPACT_CHART, parseChart, type ChartTone } from "@/lib/chart";
import { columnAlign, parseMarkdown, type Block, type Inline } from "@/lib/markdown";
import { messages } from "@/lib/messages";

function renderInline(nodes: Inline[], keyPrefix = ""): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`;
    switch (node.kind) {
      case "text":
        return <Fragment key={key}>{node.value}</Fragment>;
      case "code":
        return <code key={key} className="md-code">{node.value}</code>;
      case "strong":
        return <strong key={key}>{renderInline(node.children, `${key}.`)}</strong>;
      case "em":
        return <em key={key}>{renderInline(node.children, `${key}.`)}</em>;
      case "strike":
        return <s key={key}>{renderInline(node.children, `${key}.`)}</s>;
      case "link":
        return (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow">
            {renderInline(node.children, `${key}.`)}
          </a>
        );
      case "break":
        return <br key={key} />;
    }
  });
}

function CodeBlock({ lang, value, caret }: { lang: string; value: string; caret: ReactNode }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }
  const t = messages.live;
  return (
    <div className="md-pre">
      <div className="md-pre-bar">
        <span>{lang || "text"}</span>
        <button type="button" onClick={copy} aria-label={copied ? t.copied : t.copyCode}>
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
          {copied ? t.copied : t.copyCode}
        </button>
      </div>
      <pre>
        <code>
          {value}
          {caret}
        </code>
      </pre>
    </div>
  );
}

const tone = (name: ChartTone) => `var(--chart-${name})`;

function ChartFigure({ source, caret }: { source: string; caret: ReactNode }) {
  const scene = useMemo(() => {
    const chart = parseChart(source);
    return chart ? chartScene(chart, COMPACT_CHART) : null;
  }, [source]);
  if (!scene) return <CodeBlock lang="chart" value={source} caret={caret} />;
  return (
    <figure className="md-chart">
      <svg viewBox={`0 0 ${scene.width} ${scene.height}`} role="img" aria-label={scene.label}>
        {scene.items.map((item, i) => {
          switch (item.kind) {
            case "rect":
              return item.tone === "surface" ? null : <rect key={i} x={item.x} y={item.y} width={item.width} height={item.height} rx={2} style={{ fill: tone(item.tone) }} />;
            case "line":
              return <line key={i} x1={item.x1} y1={item.y1} x2={item.x2} y2={item.y2} style={{ stroke: tone(item.tone) }} />;
            case "path":
              return item.fill ? (
                <path key={i} d={item.d} style={{ fill: tone(item.tone) }}>
                  {item.title ? <title>{item.title}</title> : null}
                </path>
              ) : (
                <path key={i} d={item.d} className="md-chart-line" style={{ stroke: tone(item.tone) }} />
              );
            case "circle":
              return (
                <circle key={i} cx={item.cx} cy={item.cy} r={item.r} className="md-chart-dot" style={{ fill: tone(item.tone) }}>
                  {item.title ? <title>{item.title}</title> : null}
                </circle>
              );
            case "text":
              return (
                <text key={i} x={item.x} y={item.y} fontSize={item.size} textAnchor={item.anchor} fontWeight={item.weight} style={{ fill: tone(item.tone) }}>
                  {item.text}
                </text>
              );
          }
        })}
      </svg>
      {caret}
    </figure>
  );
}

function TableBlock({ block, caret }: { block: Extract<Block, { kind: "table" }>; caret: ReactNode }) {
  const align = block.header.map((_, column) => columnAlign(block, column));
  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {block.header.map((cell, c) => (
              <th key={c} style={{ textAlign: align[c] }}>
                {renderInline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} style={{ textAlign: align[c] }}>
                  {renderInline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {caret}
    </div>
  );
}

function renderBlock(block: Block, key: string, caret: ReactNode): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return (
        <p key={key}>
          {renderInline(block.children)}
          {caret}
        </p>
      );
    case "heading":
      return (
        <p key={key} className={`md-h md-h${Math.min(block.level, 3)}`} role="heading" aria-level={Math.min(block.level + 2, 6)}>
          {renderInline(block.children)}
          {caret}
        </p>
      );
    case "code":
      return block.lang === "chart" && !block.open ? <ChartFigure key={key} source={block.value} caret={caret} /> : <CodeBlock key={key} lang={block.lang} value={block.value} caret={caret} />;
    case "table":
      return <TableBlock key={key} block={block} caret={caret} />;
    case "rule":
      return <hr key={key} />;
    case "quote":
      return <blockquote key={key}>{renderBlocks(block.children, caret)}</blockquote>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag key={key} start={block.ordered && block.start !== 1 ? block.start : undefined}>
          {block.items.map((item, i) => (
            <li key={i} style={item.depth ? { marginLeft: `${item.depth * 1.1}em` } : undefined} data-depth={item.depth || undefined}>
              {renderInline(item.children)}
              {i === block.items.length - 1 ? caret : null}
            </li>
          ))}
        </Tag>
      );
    }
  }
}

function renderBlocks(blocks: Block[], caret: ReactNode) {
  return blocks.map((block, i) => renderBlock(block, String(i), i === blocks.length - 1 ? caret : null));
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const caret = streaming ? <span className="typing-caret" aria-hidden /> : null;
  if (blocks.length === 0) return <div className="md">{caret && <p>{caret}</p>}</div>;
  return <div className="md">{renderBlocks(blocks, caret)}</div>;
}
