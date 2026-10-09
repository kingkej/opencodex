import { describe, expect, test } from "bun:test";
import { resolveJevDecision, type ResolveJevDecisionOptions } from "../../src/combos/jev";
import { resolveJevComboDecision } from "../../src/combos/jev-dispatch";
import { comboConfigIssues, normalizeComboConfig } from "../../src/combos/types";
import { normalizePersistedJevDecision, createJevStatsAccumulator } from "../../src/usage/jev-stats";
import { parseComboList, toPutBody } from "../../gui/src/combo-workspace-data";
import type { OcxConfig } from "../../src/types";

const endpoint = "https://openrouter.ai/api/alpha/decisions";
const config: OcxConfig = {
  port: 0, defaultProvider: "worker",
  providers: {
    worker: { adapter: "openai-chat", baseUrl: "https://worker.example/v1", models: ["small", "large"] },
    openrouter: { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", authMode: "key", apiKey: "openrouter-test-key", liveModels: false },
    jev: { adapter: "jev-decision", baseUrl: "https://api.typesafe.ai/v1/systemone", apiKey: "typesafe-test-key" },
  },
};
const candidates = [
  { key: "worker/small", provider: "worker", model: "small", reasoningEfforts: ["low" as const] },
  { key: "worker/large", provider: "worker", model: "large", reasoningEfforts: ["medium" as const, "high" as const] },
];
const fallback = { targetKey: "worker/small", effort: "low" as const };
function options(extra: Partial<ResolveJevDecisionOptions> = {}) {
  return { body: { input: "Diagnose the failing build." }, candidates, fallback, config, service: "clef" as const, ...extra };
}
const answer = { answers: { route: { choice: "worker/large:high", confidence: 0.8 } }, usage: { input_tokens: 37, output_tokens: 0 } };

describe("Clef decision routing", () => {
  test("routes through OpenRouter Decisions with its own credential and an allowlisted joint choice", async () => {
    const sent: Parameters<NonNullable<ResolveJevDecisionOptions["post"]>>[] = [];
    const decision = await resolveJevDecision(options({
      post: async (...args) => {
        sent.push(args);
        return Response.json(answer);
      },
    }));
    expect(decision).toMatchObject({ targetKey: "worker/large", effort: "high", gate: "apply", usage: { input_tokens: 37, output_tokens: 0 } });
    expect(sent).toHaveLength(1);
    const [name, provider, url, init, dependencies] = sent[0]!;
    expect(name).toBe("openrouter");
    expect(provider.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(url).toBe(endpoint);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer openrouter-test-key");
    expect(dependencies?.isCanonicalUrl?.("openrouter", endpoint)).toBe(true);
    expect(dependencies?.isCanonicalUrl?.("openrouter", "https://other.example/")).toBe(false);
    const body = JSON.parse(init.body);
    expect(body.model).toBe("cloudflare/clef");
    expect(body.state.task).toBe("Diagnose the failing build.");
    expect(Object.keys(body.questions.route.criteria)).toEqual(["worker/small:low", "worker/large:medium", "worker/large:high"]);
    expect(init.body).not.toContain("test-key");
  });

  test("refuses a retargeted OpenRouter credential owner instead of using its key", async () => {
    const altered = structuredClone(config);
    altered.providers.openrouter!.baseUrl = "https://custom.example/v1";
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const decision = await resolveJevDecision(options({ config: altered, post: async () => { throw new Error("must not send"); } }));
      expect(decision).toMatchObject({ ...fallback, gate: "missing_key" });
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });

  test("denied admission fails open before reading the key or sending decision state", async () => {
    const altered = structuredClone(config);
    Object.defineProperty(altered.providers.openrouter, "apiKey", { get() { throw new Error("credential read before admission"); } });
    const destinations: string[] = [];
    const result = await resolveJevDecision(options({ config: altered,
      isDestinationAllowed: (provider, model) => { destinations.push(`${provider}/${model}`); return false; },
      post: async () => { throw new Error("denied destination must not send"); },
    }));
    expect(result).toMatchObject({ ...fallback, gate: "invalid", backend: "systemone" });
    expect(destinations).toEqual(["openrouter/cloudflare/clef"]);
  });

  test("the separate Clef strategy keeps its fixed service even with stale JEV model settings", async () => {
    const result = await resolveJevComboDecision({ ...options({ post: async (_name, _provider, url) => {
      expect(url).toBe(endpoint);
      return Response.json(answer);
    } }), decisionModel: "worker/large", invokeModel: async () => { throw new Error("Clef must not invoke a JEV decision model"); } });
    expect(result).toMatchObject({ gate: "apply", backend: "systemone", targetKey: "worker/large" });
  });

  test.each([
    ["http", () => new Response(null, { status: 503 })],
    ["invalid", () => Response.json({ answers: { route: { choice: "worker/large:ultra" } } })],
    ["malformed", () => new Response("not json")],
    ["redirect", () => new Response(null, { status: 302, headers: { location: "https://other.example" } })],
  ] as const)("fails open on %s without escaping the allowed targets", async (gate, response) => {
    expect(await resolveJevDecision(options({ post: async () => response() }))).toMatchObject({ ...fallback, gate });
  });

  test("uses the OpenRouter environment fallback only at its fixed endpoint", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "openrouter-env-test-key";
    const altered = structuredClone(config);
    altered.providers.openrouter!.baseUrl = "https://custom.example/v1";
    const sent: Parameters<NonNullable<ResolveJevDecisionOptions["post"]>>[] = [];
    try {
      expect(await resolveJevDecision(options({ config: altered, post: async (...args) => { sent.push(args); return Response.json(answer); } }))).toMatchObject({ gate: "apply" });
      expect(sent[0]![2]).toBe(endpoint);
      expect(sent[0]![1].baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(new Headers(sent[0]![3].headers).get("authorization")).toBe("Bearer openrouter-env-test-key");
      altered.providers.openrouter!.disabled = true;
      expect(await resolveJevDecision(options({ config: altered }))).toMatchObject({ gate: "missing_key" });
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });

  test("preserves caller cancellation through the Clef decision request", async () => {
    const abort = new AbortController();
    const reason = new Error("caller cancelled");
    await expect(resolveJevDecision(options({ signal: abort.signal, post: async () => { abort.abort(reason); throw reason; } }))).rejects.toBe(reason);
  });

  test("accepts and preserves Clef strategy in runtime and editor configuration", () => {
    const raw = { id: "clef-auto", alias: "clef-auto", strategy: "clef", targets: [{ provider: "worker", model: "small", reasoningEfforts: ["low"] }] };
    expect(comboConfigIssues("clef-auto", raw, config.providers)).toEqual([]);
    expect(normalizeComboConfig(raw as never).strategy).toBe("clef");
    const parsed = parseComboList({ combos: [raw] })[0]!;
    expect(parsed.strategy).toBe("clef");
    expect(toPutBody(parsed).combo.strategy).toBe("clef");
  });

  test("retains Clef identity and aggregates its own combo without mixing JEV records", () => {
    const raw = { version: 1, comboId: "clef-auto", service: "clef", selected: { provider: "worker", model: "large", effort: "high" }, gate: "apply", latencyMs: 100, prompt: "must drop", apiKey: "must drop" };
    const decision = normalizePersistedJevDecision(raw);
    expect(decision).toEqual({ version: 1, comboId: "clef-auto", service: "clef", selected: raw.selected, gate: "apply", latencyMs: 100 });
    const stats = createJevStatsAccumulator({ comboId: "clef-auto" });
    stats.add({ timestamp: Date.now(), status: 200, model: "clef-auto", provider: "combo", jevDecision: decision } as never);
    stats.add({ timestamp: Date.now(), status: 200, model: "jev-auto", provider: "combo", jevDecision: { ...raw, comboId: "jev-auto", service: undefined } } as never);
    expect(stats.summarize("all", Date.now()).summary.decisions).toBe(1);
  });

  test.each(["clef", undefined] as const)("joins account-pool attempts to the selected model without reporting account rotation as fallback (service: %s)", service => {
    const stats = createJevStatsAccumulator({ comboId: "auto" });
    const row = {
      requestId: "pool-rotation", timestamp: Date.now(), status: 200, model: "auto", provider: "combo",
      jevDecision: { version: 1, comboId: "auto", ...(service ? { service } : {}), selected: { provider: "openai", model: "gpt-6-luna", effort: "low" }, gate: "apply", latencyMs: 100 },
      attempts: ["openai-pabcdef", "openai-p123456"].map((provider, index) => ({ ordinal: index + 1, provider, model: "gpt-6-luna", adapter: "openai-responses", status: 200, durationMs: 10, sendCount: 1, usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 2 } })),
    };
    stats.add(row as never);
    const result = stats.summarize("all", Date.now());
    expect(result.summary.requestsWithModelFallback).toBe(0);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({ provider: "openai", model: "gpt-6-luna", picks: 1, attempts: 2, totalTokens: 24 });
    stats.add({ ...row, requestId: "model-fallback", attempts: [{ ...row.attempts[0], model: "gpt-6-astra" }] } as never);
    expect(stats.summarize("all", Date.now()).summary.requestsWithModelFallback).toBe(1);
  });
});
