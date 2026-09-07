import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const result = await build({
  entryPoints: [new URL("ui/app.ts", root).pathname],
  bundle: true, minify: true, format: "iife", platform: "browser", target: "es2022", write: false,
});
const template = await readFile(new URL("ui/evidence.html", root), "utf8");
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await mkdir(new URL("dist/ui/", root), { recursive: true });
await writeFile(new URL("dist/ui/evidence.html", root), template.replace("<!-- APP_SCRIPT -->", () => `<script>${script}</script>`));
