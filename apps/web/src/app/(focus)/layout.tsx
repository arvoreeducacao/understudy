import { requireUser } from "@/lib/session";

export default async function FocusLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return <div className="min-h-dvh bg-ink">{children}</div>;
}
