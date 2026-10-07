import { PushToggle } from "@/components/PushToggle";
import { SettingsSection } from "@/components/ui/Section";
import { messages } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { vapidKeys } from "@/server/push";

const t = messages.settings;

export default async function SettingsPage() {
  await requireUser();
  const { publicKey } = await vapidKeys();
  return (
    <div className="page">
      <div className="top">
        <div>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
      </div>
      <div className="page-body set-page">
        <SettingsSection id="push" title={t.pushTitle} hint={t.pushBody}>
          <PushToggle publicKey={publicKey} />
        </SettingsSection>
        <SettingsSection id="install" title={t.installTitle} hint={t.installBody}>
          <ul className="card rows">
            <li className="row">{t.installIphone}</li>
            <li className="row">{t.installAndroid}</li>
          </ul>
        </SettingsSection>
      </div>
    </div>
  );
}
