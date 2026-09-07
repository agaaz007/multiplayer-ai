import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

const frame = document.getElementById("app-frame") as HTMLIFrameElement;
const status = document.getElementById("status")!;
const query = document.getElementById("query") as HTMLInputElement;
const loading = document.getElementById("loading")!;
const retry = document.getElementById("retry") as HTMLButtonElement;
const fallback = document.getElementById("fallback")!;
const buttons = [...document.querySelectorAll<HTMLButtonElement>('#search, [data-query], #retry')];
const nonce = (document.querySelector('meta[name="ledger-preview-nonce"]') as HTMLMetaElement).content;
let theme: "light" | "dark" = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let bridge: AppBridge | undefined;
let busy = false;

async function api(request: unknown) {
  const response = await fetch("/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Preview request failed (${response.status})`);
  return response.json();
}

async function connect(): Promise<AppBridge> {
  const resource: ReadResourceResult = await api({ action: "resource" });
  const content = resource.contents[0];
  if (!content || !("text" in content)) throw new Error("The MCP resource was not HTML.");
  const diagnostics: string[] = [];
  const trace = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    const phase = event.data?.ledgerPreviewPhase ?? event.data?.method;
    if (typeof phase === "string" && diagnostics.length < 12) diagnostics.push(phase.slice(0, 200));
  };
  window.addEventListener("message", trace);
  const active = new AppBridge(null, { name: "Ledger local preview", version: "0.1.0" }, { serverTools: {} }, {
    hostContext: { theme, displayMode: "inline" },
  });
  active.oncalltool = async params => {
    // The HTTP endpoint independently enforces the same read-only allowlist.
    if (!["ledger_search", "ledger_get", "ledger_show_contribution"].includes(params.name)) throw new Error("This preview only supports evidence reads.");
    return api({ action: "call", name: params.name, arguments: params.arguments });
  };
  active.onsizechange = ({ height }) => { if (height && Number.isFinite(height)) frame.style.height = `${Math.max(86, Math.min(30_000, height))}px`; };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await active.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
    // Keep an opaque sandbox origin. Both the parent and child CSP authorize this one bundle.
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`;
    const probe = `<script nonce="${nonce}">window.parent.postMessage({ledgerPreviewPhase:"card-script-started"},"*");window.addEventListener("error",function(e){window.parent.postMessage({ledgerPreviewPhase:"card-error: "+e.message},"*")});window.addEventListener("securitypolicyviolation",function(e){window.parent.postMessage({ledgerPreviewPhase:"blocked: "+e.violatedDirective},"*")});</script>`;
    await new Promise<void>((resolve, reject) => {
      active.oninitialized = () => resolve();
      timer = setTimeout(() => reject(new Error(`The card did not connect within 10 seconds. Connection trace: ${diagnostics.join(" → ") || "no message from the card"}`)), 10_000);
      frame.hidden = false;
      frame.srcdoc = content.text.replace("<head>", `<head>${policy}`).replace("<script>", `${probe}<script nonce="${nonce}">`);
    });
    return active;
  } catch (error) {
    await active.close();
    frame.srcdoc = ""; frame.hidden = true;
    throw error;
  } finally {
    clearTimeout(timer);
    window.removeEventListener("message", trace);
  }
}

async function search() {
  if (busy || !query.reportValidity()) return;
  busy = true;
  buttons.forEach(button => { button.disabled = true; });
  loading.hidden = Boolean(bridge);
  status.textContent = "Searching your team’s records…";
  retry.hidden = true; fallback.hidden = true;
  const args = { query: query.value.trim(), limit: 6 };
  // Preserve the real text response if the interactive view cannot initialize.
  const resultPromise = api({ action: "call", name: "ledger_search", arguments: args }) as Promise<CallToolResult>;
  void resultPromise.catch(() => {});
  try {
    bridge ??= await connect();
    loading.hidden = true;
    await bridge.sendToolInput({ arguments: args });
    const result = await resultPromise;
    await bridge.sendToolResult(result);
    status.textContent = result.isError ? "The search returned an error. Open the card for details." : "Connected to Ledger · Click the pill to explore";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    retry.hidden = false;
    await bridge?.close(); bridge = undefined;
    frame.srcdoc = ""; frame.hidden = true;
    try {
      const result = await resultPromise;
      fallback.querySelector("pre")!.textContent = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      fallback.hidden = false;
    } catch { /* The request error is already shown above. */ }
  } finally {
    busy = false; loading.hidden = true;
    buttons.forEach(button => { button.disabled = false; });
  }
}

document.getElementById("search-form")!.addEventListener("submit", event => { event.preventDefault(); void search(); });
retry.addEventListener("click", () => { void search(); });
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-query]")) {
  button.addEventListener("click", () => { query.value = button.dataset.query!; void search(); });
}
document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); query.focus(); query.select(); }
});
document.getElementById("theme")!.addEventListener("click", () => {
  theme = theme === "light" ? "dark" : "light";
  document.documentElement.style.colorScheme = theme;
  bridge?.setHostContext({ theme, displayMode: "inline" });
});
document.documentElement.style.colorScheme = theme;
void search();
