import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { clearCodexUpstreamHealth, clearThreadAccountMap, recordCodexUpstreamOutcome } from "../src/codex/routing";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function cooledPoolConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "key-alpha-000111222333",
      },
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    codexAccounts: [{ id: "a", email: "a@test", isMain: false }],
    activeCodexAccountId: "a",
  } as OcxConfig;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-cooldown-scope-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-cooldown-scope-"));
  process.env.OPENCODEX_HOME = testDir;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
});

describe("Codex account cooldown is scoped to forward-auth routes", () => {
  test("a cooled Codex pool account does not 429 a key-authenticated provider", async () => {
    const originalFetch = globalThis.fetch;
    let upstreamCalls = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://api.x.ai/v1/chat/completions") {
        upstreamCalls++;
        return new Response(JSON.stringify({
          id: "chatcmpl-cooldown-scope",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }), { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    let server: ReturnType<typeof startServer> | null = null;
    try {
      const config = cooledPoolConfig();
      saveConfig(config);
      // Upstream quota 429 on the active pool account: cooldown armed for "a".
      recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "3600" });
      server = startServer(0);

      const res = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "xai/grok-4.5", input: "hello", stream: false }),
      });

      expect(res.status).toBe(200);
      expect(upstreamCalls).toBe(1);
      const json = await res.json() as { output?: { type: string; content?: { text?: string }[] }[] };
      expect(json.output?.find(o => o.type === "message")?.content?.[0]?.text).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
      server?.stop(true);
    }
  });

  test("the same cooldown still 429s a forward-auth Codex route", async () => {
    const originalFetch = globalThis.fetch;
    let server: ReturnType<typeof startServer> | null = null;
    try {
      const config = cooledPoolConfig();
      saveConfig(config);
      recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "3600" });
      server = startServer(0);

      const res = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: false }),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).not.toBeNull();
      const json = await res.json() as { error?: { message?: string } };
      expect(json.error?.message).toContain("cooling down");
    } finally {
      server?.stop(true);
    }
  });
});
