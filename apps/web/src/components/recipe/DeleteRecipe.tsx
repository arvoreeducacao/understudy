"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { deleteRecipe } from "@/app/actions/recipes";
import { ConfirmButton } from "@/components/ConfirmButton";
import { messages } from "@/lib/messages";

export function DeleteRecipe({ recipeId, title }: { recipeId: string; title: string }) {
  const t = messages.recipe;
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <p className="m-0 min-w-0 flex-1 text-[12.5px] text-ash">{t.deleteHint}</p>
      <ConfirmButton
        className="btn warn sm"
        label={t.deleteButton}
        question={t.deleteConfirm(title)}
        disabled={pending}
        onConfirm={() =>
          start(async () => {
            const result = await deleteRecipe(recipeId);
            router.push(result.redirectTo);
          })
        }
      />
    </div>
  );
}
