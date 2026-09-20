import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
// One self-contained document per MCP Apps resource: a host loads the HTML and nothing else, so
// there is no shared bundle to fetch. Adding a card is a row here, never another branch.
const cards = [
  { entry: "ui/app.ts", template: "ui/evidence.html", out: "dist/ui/evidence.html" },
  { entry: "ui/memory.ts", template: "ui/memory.html", out: "dist/ui/memory.html" },
];
await mkdir(new URL("dist/ui/", root), { recursive: true });
for (const card of cards) {
  const result = await build({
    entryPoints: [new URL(card.entry, root).pathname],
    bundle: true, minify: true, format: "iife", platform: "browser", target: "es2022", write: false,
  });
  const template = await readFile(new URL(card.template, root), "utf8");
  const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  await writeFile(new URL(card.out, root), template.replace("<!-- APP_SCRIPT -->", () => `<script>${script}</script>`));
}
