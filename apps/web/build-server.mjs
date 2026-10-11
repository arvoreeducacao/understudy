import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";

await build({
  entryPoints: { server: "server.ts", "create-user": "scripts/create-user.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  external: ["next", "next/*", "pg-native", "bufferutil", "utf-8-validate"],
  banner: {
    js: "import { createRequire as __understudyCreateRequire } from 'node:module'; const require = __understudyCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

const resolve = createRequire(import.meta.url).resolve;
await copyFile(resolve("@resvg/resvg-wasm/index_bg.wasm"), "dist/resvg.wasm");
await mkdir("dist/fonts", { recursive: true });
for (const [from, to] of [
  ["@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf", "Inter_400Regular.ttf"],
  ["@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf", "Inter_600SemiBold.ttf"],
  ["@expo-google-fonts/inter/LICENSE_FONT", "Inter-LICENSE.txt"],
]) {
  await copyFile(resolve(from), `dist/fonts/${to}`);
}
