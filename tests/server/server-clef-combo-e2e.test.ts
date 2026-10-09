import { afterEach, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearGatherRoutedModelsInflight } from "../../src/codex/catalog";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";

afterEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearGatherRoutedModelsInflight();
});

test.each([true, false])("Clef selects target and effort once, then preserves ordinary child fallback (decision valid: %s)", async valid => {
  let decisions = 0;
  const decisionUrls: string[] = [];
  const config: OcxConfig = {
    port: 0, defaultProvider: "worker",
    providers: {
      worker: {
        adapter: "openai-chat", baseUrl: "https://worker.example/v1", liveModels: false, models: ["small", "large"],
        modelReasoningEfforts: { small: ["low", "medium"], large: ["low", "medium", "high"] },
      },
      openrouter: {
        adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", apiKey: "clef-test-key", liveModels: false,
        fetch: (async (input: RequestInfo | URL) => {
          decisions++;
          decisionUrls.push(String(input));
          return Response.json({ answers: { route: { choice: valid ? "worker/large:high" : "worker/large:ultra" } } });
        }) as typeof fetch,
      },
    },
    combos: { "clef-auto": { alias: "clef-auto", strategy: "clef" as never, reasoningEffortMode: "adaptive", targets: [
      { provider: "worker", model: "small" }, { provider: "worker", model: "large", reasoningEfforts: ["high"] },
    ] } },
  };
  const body = { model: "clef-auto", input: "Solve the difficult issue.", stream: false, service_tier: "priority", reasoning: { effort: "low" } };
  const request = new Request("http://127.0.0.1/v1/responses", { method: "POST", body: JSON.stringify(body) });
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const children: Record<string, unknown>[] = [];
  const budget = createTranslatorBudget();
  try {
    const response = await executeComboResponses(request, body, "clef-auto", config, logCtx, { translatorBudget: budget }, {
      async handleResponses(req) {
        children.push(await req.json() as Record<string, unknown>);
        return children.length === 1
          ? Response.json({ error: { message: "retry target" } }, { status: 502 })
          : Response.json({ id: "resp-clef", object: "response", status: "completed", output: [] });
      },
      async handleComboResponses() { throw new Error("unexpected nested combo"); },
    });
    expect(response.status).toBe(200);
    expect(decisions).toBe(1);
    expect(decisionUrls).toEqual(["https://openrouter.ai/api/alpha/decisions"]);
    expect(children.map(row => row.model)).toEqual(valid ? ["worker/large", "worker/small"] : ["worker/small", "worker/large"]);
    expect(children[0]!.reasoning).toMatchObject({ effort: valid ? "high" : "medium" });
    expect(children[0]!.service_tier).toBeUndefined();
    expect(logCtx.jevDecision).toMatchObject({ comboId: "clef-auto", service: "clef", gate: valid ? "apply" : "invalid", selected: { model: valid ? "large" : "small", effort: valid ? "high" : "medium" } });
  } finally {
    budget.dispose();
  }
});
