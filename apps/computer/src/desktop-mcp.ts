import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { cdpCall, cdpConnect, pageTargets } from "./cdp.ts";
import { DISPLAY, SCREEN } from "./desktop.ts";

const APPS: Record<string, string[]> = {
  browser: ["open-browser"],
  terminal: ["lxterminal"],
  files: ["pcmanfm"],
  writer: ["libreoffice", "--writer"],
  calc: ["libreoffice", "--calc"],
  impress: ["libreoffice", "--impress"],
};

const point = { x: { type: "number", description: `0 to ${SCREEN.width - 1}, left to right` }, y: { type: "number", description: `0 to ${SCREEN.height - 1}, top to bottom` } };

export const DESKTOP_TOOLS = [
  {
    name: "desktop_screenshot",
    description: `See your whole screen (${SCREEN.width}x${SCREEN.height}): every window, the app bar at the bottom and the browser with its tabs. Take one before clicking and after anything that changes the screen; coordinates for the other desktop tools come from this image.`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "desktop_click",
    description: "Click a point on the screen, in any program (terminal, files, Writer, Calc, dialogs, the app bar, the browser's own buttons). A click inside a web page is refused; use the browser tools there.",
    inputSchema: {
      type: "object",
      properties: { ...point, button: { type: "string", enum: ["left", "right", "middle"] }, double: { type: "boolean" } },
      required: ["x", "y"],
    },
  },
  {
    name: "desktop_drag",
    description: "Press at one point, move to another and release (select text, move a window, drag a file).",
    inputSchema: {
      type: "object",
      properties: { fromX: point.x, fromY: point.y, toX: point.x, toY: point.y },
      required: ["fromX", "fromY", "toX", "toY"],
    },
  },
  {
    name: "desktop_type",
    description: "Type text into whatever has the keyboard focus. Refused while a web page has the focus; use the browser tools there.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "desktop_key",
    description: 'Press a key or a combination, like "Return", "Escape", "Tab", "ctrl+s", "ctrl+shift+t", "alt+Tab", "super".',
    inputSchema: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
  },
  {
    name: "desktop_scroll",
    description: "Scroll at a point. Positive amount scrolls down, negative up; each step is one wheel notch.",
    inputSchema: { type: "object", properties: { ...point, amount: { type: "number" } }, required: ["x", "y", "amount"] },
  },
  {
    name: "desktop_open",
    description: `Open a program on the screen: ${Object.keys(APPS).join(", ")}. Pass a file or folder in "path" to open it with that program.`,
    inputSchema: { type: "object", properties: { app: { type: "string", enum: Object.keys(APPS) }, path: { type: "string" } }, required: ["app"] },
  },
];

const clampX = (value: unknown) => String(Math.max(0, Math.min(SCREEN.width - 1, Math.round(Number(value) || 0))));
const clampY = (value: unknown) => String(Math.max(0, Math.min(SCREEN.height - 1, Math.round(Number(value) || 0))));

export function desktopCommand(name: string, args: Record<string, unknown>): string[] | null {
  if (name === "desktop_click") {
    const button = args.button === "right" ? "3" : args.button === "middle" ? "2" : "1";
    return ["mousemove", clampX(args.x), clampY(args.y), "click", ...(args.double ? ["--repeat", "2"] : []), button];
  }
  if (name === "desktop_drag") return ["mousemove", clampX(args.fromX), clampY(args.fromY), "mousedown", "1", "mousemove", "--sync", clampX(args.toX), clampY(args.toY), "mouseup", "1"];
  if (name === "desktop_type") return ["type", "--delay", "8", "--", String(args.text ?? "")];
  if (name === "desktop_key") {
    const keys = String(args.keys ?? "").trim().split(/\s+/).filter((key) => /^[A-Za-z0-9_+]+$/.test(key));
    return keys.length ? ["key", "--", ...keys] : null;
  }
  if (name === "desktop_scroll") {
    const amount = Math.round(Number(args.amount) || 0);
    if (!amount) return null;
    return ["mousemove", clampX(args.x), clampY(args.y), "click", "--repeat", String(Math.min(30, Math.abs(amount))), amount > 0 ? "5" : "4"];
  }
  return null;
}

export type PageWindow = { screenX: number; screenY: number; outerWidth: number; outerHeight: number; innerWidth: number; innerHeight: number; scale: number; visible: boolean; focused: boolean };

export type Rect = { x: number; y: number; width: number; height: number };

export const PAGE_WINDOW_SCRIPT = `({ screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight, scale: devicePixelRatio || 1, visible: document.visibilityState === "visible", focused: document.hasFocus() })`;

export function pageViewport(page: PageWindow): Rect {
  const scale = page.scale > 0 ? page.scale : 1;
  const border = Math.max(0, (page.outerWidth - page.innerWidth) / 2);
  return {
    x: (page.screenX + border) * scale,
    y: (page.screenY + Math.max(0, page.outerHeight - page.innerHeight - border)) * scale,
    width: page.innerWidth * scale,
    height: page.innerHeight * scale,
  };
}

export function insideRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

const DEVTOOLS_KEYS = new Set(["f12", "ctrl+shift+i", "ctrl+shift+j", "ctrl+shift+c"]);

function normalizeCombo(combo: string): string {
  const parts = combo.toLowerCase().split("+").map((part) => (part === "control" ? "ctrl" : part));
  const key = parts.pop() ?? "";
  return [...parts.sort(), key].join("+");
}

const WEB_PAGE_HINT = "Use the browser tools (browser_click, browser_type, browser_press_key and the rest) for anything inside a web page; the desktop tools are for other programs and the browser's own buttons and menus.";

export const PAGE_GUARDED_TOOLS = new Set(["desktop_click", "desktop_drag", "desktop_type", "desktop_key"]);

export type ScreenWindow = Rect & { browser: boolean };

export function parseClientStack(text: string): string[] {
  return (text.split("#")[1] ?? "").split(",").map((id) => id.trim()).filter((id) => /^0x[0-9a-f]+$/i.test(id));
}

export function parseWindowInfo(text: string): Rect | null {
  const read = (label: string) => Number(text.match(new RegExp(`${label}:\\s*(-?\\d+)`))?.[1]);
  if (!/Map State:\s*IsViewable/.test(text)) return null;
  const rect = { x: read("Absolute upper-left X"), y: read("Absolute upper-left Y"), width: read("Width"), height: read("Height") };
  return Object.values(rect).every(Number.isFinite) ? rect : null;
}

export function isBrowserWindowClass(text: string): boolean {
  return /chrom/i.test(text.split("=").slice(1).join("="));
}

export function topWindowAt(x: number, y: number, stack: ScreenWindow[]): ScreenWindow | undefined {
  return stack.filter((window) => insideRect(x, y, window)).pop();
}

export function desktopRefusal(name: string, args: Record<string, unknown>, pages: PageWindow[] | null, stack: ScreenWindow[] | null = null): string | null {
  if (!PAGE_GUARDED_TOOLS.has(name)) return null;
  if (pages === null) return `Refused: the computer could not check whether this would act on a web page, so it did nothing. ${WEB_PAGE_HINT}`;
  const shown = pages.filter((page) => page.visible);
  if (!shown.length) return null;
  if (name === "desktop_click" || name === "desktop_drag") {
    const points = name === "desktop_click" ? [[args.x, args.y]] : [[args.fromX, args.fromY], [args.toX, args.toY]];
    for (const [x, y] of points) {
      const px = Number(clampX(x));
      const py = Number(clampY(y));
      const top = stack ? topWindowAt(px, py, stack) : undefined;
      if (stack && top && !top.browser) continue;
      if (shown.some((page) => insideRect(px, py, pageViewport(page)))) return `Refused: (${px}, ${py}) is inside a web page in the browser. ${WEB_PAGE_HINT}`;
    }
    return null;
  }
  if (shown.some((page) => page.focused)) return `Refused: the keyboard focus is on a web page in the browser. ${WEB_PAGE_HINT}`;
  if (name === "desktop_type" && /javascript\s*:/i.test(String(args.text ?? ""))) return `Refused: typing a javascript: address would run code in a web page. ${WEB_PAGE_HINT}`;
  if (name === "desktop_key" && String(args.keys ?? "").trim().split(/\s+/).some((combo) => DEVTOOLS_KEYS.has(normalizeCombo(combo)))) return `Refused: that shortcut opens the browser's developer tools. ${WEB_PAGE_HINT}`;
  return null;
}

export async function browserPageWindows(): Promise<PageWindow[] | null> {
  let targets: Awaited<ReturnType<typeof pageTargets>>;
  try {
    targets = await pageTargets();
  } catch {
    return [];
  }
  try {
    return await Promise.all(
      targets.map(async (target) => {
        const socket = await cdpConnect(target.webSocketDebuggerUrl!, 2000);
        try {
          const reply = await cdpCall(socket, "Runtime.evaluate", { expression: PAGE_WINDOW_SCRIPT, returnByValue: true }, 2000);
          const value = reply?.result?.value;
          if (!value || typeof value.innerWidth !== "number") throw new Error("no window");
          return value as PageWindow;
        } finally {
          socket.close();
        }
      }),
    );
  } catch {
    return null;
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, capture = false): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

async function screenWindows(env: NodeJS.ProcessEnv): Promise<ScreenWindow[] | null> {
  const list = await run("xprop", ["-root", "_NET_CLIENT_LIST_STACKING"], env, true);
  if (list.code !== 0) return null;
  const stack: ScreenWindow[] = [];
  for (const id of parseClientStack(list.stdout.toString())) {
    const info = await run("xwininfo", ["-id", id], env, true);
    const rect = info.code === 0 ? parseWindowInfo(info.stdout.toString()) : null;
    if (!rect) continue;
    const wmClass = await run("xprop", ["-id", id, "WM_CLASS"], env, true);
    stack.push({ ...rect, browser: wmClass.code === 0 && isBrowserWindowClass(wmClass.stdout.toString()) });
  }
  return stack;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export async function callDesktopTool(name: string, args: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<{ content: Content[]; isError?: boolean }> {
  if (name === "desktop_screenshot") {
    const shot = await run("ffmpeg", ["-loglevel", "error", "-f", "x11grab", "-draw_mouse", "1", "-video_size", `${SCREEN.width}x${SCREEN.height}`, "-i", env.DISPLAY ?? DISPLAY, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "-"], env, true);
    if (shot.code !== 0 || !shot.stdout.length) return { content: [{ type: "text", text: `could not see the screen: ${shot.stderr.trim() || "no desktop"}` }], isError: true };
    return { content: [{ type: "image", data: shot.stdout.toString("base64"), mimeType: "image/jpeg" }] };
  }
  if (name === "desktop_open") {
    const app = APPS[String(args.app)];
    if (!app) return { content: [{ type: "text", text: `unknown app ${String(args.app)}` }], isError: true };
    const [command, ...rest] = app;
    const child = spawn(command, [...rest, ...(args.path ? [String(args.path)] : [])], { env, stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return { content: [{ type: "text", text: `opening ${String(args.app)}; take a screenshot in a moment to see it` }] };
  }
  const refusal = PAGE_GUARDED_TOOLS.has(name) ? desktopRefusal(name, args, await browserPageWindows(), name === "desktop_click" || name === "desktop_drag" ? await screenWindows(env) : null) : null;
  if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
  const command = desktopCommand(name, args);
  if (!command) return { content: [{ type: "text", text: `nothing to do for ${name} with ${JSON.stringify(args)}` }], isError: true };
  const result = await run("xdotool", command, env);
  if (result.code !== 0) return { content: [{ type: "text", text: `${name} failed: ${result.stderr.trim() || `exit ${result.code}`}` }], isError: true };
  return { content: [{ type: "text", text: "done" }] };
}

async function serve() {
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || DISPLAY };
  const reply = (id: unknown, result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  for await (const line of createInterface({ input: process.stdin })) {
    let message: { id?: unknown; method?: string; params?: any };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    if (message.method === "initialize") reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "understudy-desktop", version: "1" } });
    else if (message.method === "tools/list") reply(message.id, { tools: DESKTOP_TOOLS });
    else if (message.method === "ping") reply(message.id, {});
    else if (message.method === "tools/call" && DESKTOP_TOOLS.some((tool) => tool.name === message.params?.name)) {
      reply(message.id, await callDesktopTool(message.params.name, message.params.arguments ?? {}, env));
    } else {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  void serve();
}
