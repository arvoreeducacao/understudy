import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/session";
import { abandonSignIn, finishSignIn } from "@/server/connector-oauth";
import { forgetServer, testConnection } from "@/server/upstream";

function back(path: string) {
  return redirect(`${env.publicUrl.replace(/\/$/, "")}${path}`);
}

export async function GET(request: Request) {
  await requireAdmin();
  const params = new URL(request.url).searchParams;
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";
  if (!state) return back("/admin#connected-tools");
  if (!code) {
    const server = await abandonSignIn(state);
    return back(server ? `/admin/connectors/${server.id}?signin=refused` : "/admin#connected-tools");
  }
  const finished = await finishSignIn(state, code);
  if (!finished) return back("/admin#connected-tools");
  forgetServer(finished.server.id);
  const test = finished.signedIn ? await testConnection(finished.server) : null;
  return back(`/admin/connectors/${finished.server.id}?signin=${test?.ok ? "done" : "failed"}`);
}
