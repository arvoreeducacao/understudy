"use client";

import { messages } from "@/lib/messages";
import { Select } from "@/components/ui/Select";

const t = messages.recipe;

export function GroupCard({ groups, roomId, onRoomId }: { groups: { id: string; name: string }[]; roomId: string | null; onRoomId: (value: string | null) => void }) {
  return (
    <section className="card rp-card" aria-labelledby="rp-group">
      <h2 id="rp-group" className="rp-h2">
        {t.groupTitle}
      </h2>
      <p className="m-0 text-[13.5px] leading-[1.6]">{t.groupLead}</p>
      <Select
        size="sm"
        aria-labelledby="rp-group"
        value={roomId ?? ""}
        onChange={(next) => onRoomId(next || null)}
        options={[{ value: "", label: t.groupAuto }, ...groups.map((group) => ({ value: group.id, label: group.name }))]}
      />
      <p className="m-0 text-[12.5px] text-smoke">{t.groupHint}</p>
    </section>
  );
}
