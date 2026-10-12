"use client";

import { useCallback, useSyncExternalStore } from "react";

export const COARSE_POINTER = "(pointer: coarse)";
export const PHONE = "(pointer: coarse) and (max-width: 760px), (pointer: coarse) and (max-height: 500px)";

export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (notify: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
