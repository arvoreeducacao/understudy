"use client";

import { useTransition } from "react";
import { setLanguage } from "@/app/actions/preferences";
import { Select } from "@/components/ui/Select";
import { LOCALE_NAMES, LOCALES, messages } from "@/lib/messages";

export function LanguagePicker({ current }: { current: string }) {
  const [pending, start] = useTransition();
  return (
    <div className="max-w-[280px]">
      <Select
        aria-label={messages.settings.languageTitle}
        value={current}
        disabled={pending}
        options={LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] ?? locale }))}
        onChange={(locale) =>
          start(async () => {
            if (locale === current) return;
            const result = await setLanguage(locale);
            if (result.ok) window.location.reload();
          })
        }
      />
    </div>
  );
}
