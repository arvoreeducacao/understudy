import type { FileEntry } from "@understudy/protocol";

export function latestOutputs(files: FileEntry[], count = 3) {
  return [...files].sort((x, y) => y.updatedAt - x.updatedAt).slice(0, count);
}

export function fileKind(path: string) {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return { label: "XLS", tone: "sheet" };
  if (["doc", "docx", "md", "txt", "odt", "rtf"].includes(ext)) return { label: "DOC", tone: "doc" };
  if (ext === "pdf") return { label: "PDF", tone: "pdf" };
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return { label: "IMG", tone: "img" };
  if (["ppt", "pptx", "key", "odp"].includes(ext)) return { label: "PPT", tone: "deck" };
  if (["mp4", "mov", "webm"].includes(ext)) return { label: "VID", tone: "img" };
  return { label: ext.slice(0, 3).toUpperCase() || "FILE", tone: "other" };
}
