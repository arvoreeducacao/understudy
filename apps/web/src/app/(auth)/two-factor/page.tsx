import { redirect } from "next/navigation";
import { and, eq, isNotNull } from "drizzle-orm";
import { TwoFactorSetup } from "@/components/TwoFactorSetup";
import { userBlock } from "@/lib/account-gate";
import { getDb, schema } from "@/lib/db";
import { currentUser } from "@/lib/session";

export default async function TwoFactorPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  const block = userBlock(user);
  if (block !== "two-factor") redirect(block ? `/${block}` : "/");
  const [credential] = await getDb()
    .select({ id: schema.account.id })
    .from(schema.account)
    .where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, "credential"), isNotNull(schema.account.password)));
  return <TwoFactorSetup email={user.email} needsPassword={Boolean(credential)} />;
}
