export type GitService = "git-upload-pack" | "git-receive-pack";

export type GitRoute = { owner: string; repo: string; service: GitService; advertise: boolean };

export type PushCommand = { oldId: string; newId: string; ref: string };

export type PushRequest = { commands: PushCommand[]; capabilities: string[] };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const OBJECT_ID = "[0-9a-f]{40}|[0-9a-f]{64}";
const COMMAND = new RegExp(`^(${OBJECT_ID}) (${OBJECT_ID}) (refs/[^\\s\\0]+)$`);
const SIDEBAND_CHUNK = 990;

export const FLUSH = Buffer.from("0000");

export function parseGitRoute(rest: string, search: URLSearchParams): GitRoute | null {
  const match = rest.match(/^\/github\.com\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!match) return null;
  const [, owner, named, endpoint] = match;
  const repo = named.replace(/\.git$/, "");
  if (!OWNER.test(owner) || !REPO.test(repo) || /^\.+$/.test(repo)) return null;
  if (endpoint !== "info/refs") return { owner, repo, service: endpoint as GitService, advertise: false };
  const service = search.get("service");
  if (service !== "git-upload-pack" && service !== "git-receive-pack") return null;
  return { owner, repo, service, advertise: true };
}

export function pktLine(data: string | Buffer) {
  const payload = typeof data === "string" ? Buffer.from(data) : data;
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, "0")), payload]);
}

function oneLine(message: string) {
  return message.replace(/\s+/g, " ").trim().slice(0, 900);
}

export function refusedAdvertisement(service: GitService, message: string) {
  return Buffer.concat([pktLine(`# service=${service}\n`), FLUSH, pktLine(`ERR ${oneLine(message)}\n`)]);
}

export function readPushRequest(body: Buffer): PushRequest | null {
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let at = 0;
  for (;;) {
    const head = body.subarray(at, at + 4).toString("latin1");
    if (!/^[0-9a-f]{4}$/i.test(head)) return null;
    const size = Number.parseInt(head, 16);
    if (size === 0) return { commands, capabilities };
    if (size < 4 || at + size > body.length) return null;
    let line = body.subarray(at + 4, at + size).toString("utf8").replace(/\n$/, "");
    at += size;
    if (line.startsWith("shallow ")) continue;
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      if (commands.length === 0) capabilities = line.slice(nul + 1).split(" ").filter(Boolean);
      line = line.slice(0, nul);
    }
    const command = line.match(COMMAND);
    if (!command) return null;
    commands.push({ oldId: command[1], newId: command[2], ref: command[3] });
  }
}

export function deletes(command: PushCommand) {
  return /^0+$/.test(command.newId);
}

export function usesSideband(capabilities: string[]) {
  return capabilities.includes("side-band-64k") || capabilities.includes("side-band");
}

export function sideband(band: 1 | 2, data: string | Buffer) {
  const payload = typeof data === "string" ? Buffer.from(data) : data;
  const packets: Buffer[] = [];
  let at = 0;
  do {
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), payload.subarray(at, at + SIDEBAND_CHUNK)])));
    at += SIDEBAND_CHUNK;
  } while (at < payload.length);
  return Buffer.concat(packets);
}

export function progress(capabilities: string[], message: string) {
  return usesSideband(capabilities) ? sideband(2, `${oneLine(message)}\n`) : Buffer.alloc(0);
}

export function refusedPush(request: PushRequest, message: string) {
  const reason = oneLine(message);
  const report = Buffer.concat([pktLine("unpack ok\n"), ...request.commands.map((command) => pktLine(`ng ${command.ref} ${reason}\n`)), FLUSH]);
  if (!usesSideband(request.capabilities)) return report;
  return Buffer.concat([sideband(2, `${reason}\n`), sideband(1, report), FLUSH]);
}
