"use client";

import { useEffect } from "react";
import { viewportBox } from "@/lib/visual-viewport";

export function useVisualViewport() {
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    const root = document.documentElement;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const box = viewportBox(window.innerHeight, visual);
      root.style.setProperty("--vv-h", `${box.height}px`);
      root.style.setProperty("--vv-top", `${box.top}px`);
      root.toggleAttribute("data-keyboard", box.keyboard);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    visual.addEventListener("resize", schedule);
    visual.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      visual.removeEventListener("resize", schedule);
      visual.removeEventListener("scroll", schedule);
      root.style.removeProperty("--vv-h");
      root.style.removeProperty("--vv-top");
      root.removeAttribute("data-keyboard");
    };
  }, []);
}
