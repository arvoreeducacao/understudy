import { formatBytes } from "@understudy/protocol";
import type { PendingFile } from "@/lib/db/schema";
import { messages as copy } from "@/lib/messages";
import { readWholeFile } from "../artifacts/service";
import type { Hub } from "../hub";

export type ReadFile = { filename: string; contentType: string; content: Buffer };

export async function readReplyFiles(hub: Hub, agentId: string, pending: PendingFile[], maxTotal: number, maxEach = maxTotal) {
  const files: ReadFile[] = [];
  const left: string[] = [];
  let total = 0;
  for (const file of pending) {
    if (file.size > maxEach || total + file.size > maxTotal) {
      left.push(`${file.name} (${formatBytes(file.size)})`);
      continue;
    }
    const read = await readWholeFile(hub, agentId, file.path, Math.min(maxEach, maxTotal - total));
    if (!read.data) {
      left.push(file.name);
      continue;
    }
    total += read.data.length;
    files.push({ filename: file.name, contentType: file.mime, content: read.data });
  }
  return { files, note: left.length ? copy.channels.notAttached(left.join(", ")) : "" };
}
