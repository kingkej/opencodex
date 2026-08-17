import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../src/adapters/anthropic";
import { withTestTranslatorBudget } from "./helpers/translator-budget";
import {
  anthropicEmptyRetryRequest,
  retryEmptyAnthropicBatch,
  retryEmptyAnthropicStream,
} from "../src/adapters/anthropic-empty-retry";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { buildResponseJSON } from "../src/bridge";

// parseStream/parseResponse take a translator budget; the helper supplies a disposed-after-test one.
const createAnthropicAdapter = (...args: Parameters<typeof createAnthropicAdapterProduction>) =>
  withTestTranslatorBudget(createAnthropicAdapterProduction(...args));

const provider = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-test",
  authMode: "apiKey",
} as unknown as OcxProviderConfig;

async function collect(events: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function* streamOf(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  yield* events;
}

function usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

describe("anthropic stop reason and empty-response recovery", () => {
  test("stream parser preserves message_delta stop_reason", async () => {
    const body = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const events = await collect(createAnthropicAdapter(provider).parseStream(new Response(body)));

    expect(events).toEqual([
      { type: "done", usage: { inputTokens: 10, outputTokens: 2 }, stopReason: "end_turn" },
    ]);
  });

  test("non-stream parser preserves stop_reason", async () => {
    const events = await createAnthropicAdapter(provider).parseResponse!(new Response(JSON.stringify({
      content: [],
      stop_reason: "refusal",
      usage: { input_tokens: 12, output_tokens: 3 },
    })));

    expect(events).toEqual([
      { type: "done", usage: { inputTokens: 12, outputTokens: 3 }, stopReason: "refusal" },
    ]);
  });

  test("retries an empty end_turn once and merges usage", async () => {
    let retries = 0;
    const events = await collect(retryEmptyAnthropicStream(
      streamOf([{ type: "done", stopReason: "end_turn", usage: usage(40, 2) }]),
      async () => {
        retries++;
        return streamOf([
          { type: "text_delta", text: "recovered" },
          { type: "done", stopReason: "end_turn", usage: usage(40, 9) },
        ]);
      },
    ));

    expect(retries).toBe(1);
    expect(events).toEqual([
      { type: "text_delta", text: "recovered" },
      { type: "done", stopReason: "end_turn", usage: usage(80, 11) },
    ]);
  });

  test("cancels the first upstream stream before starting the retry", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`
          + `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`
          + `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ));
      },
      cancel() { cancelled = true; },
    }));

    const events = await collect(retryEmptyAnthropicStream(
      createAnthropicAdapter(provider).parseStream(response),
      async () => streamOf([
        { type: "text_delta", text: "recovered" },
        { type: "done", stopReason: "end_turn", usage: usage(10, 4) },
      ]),
    ));

    expect(cancelled).toBe(true);
    expect(events.some(event => event.type === "text_delta")).toBe(true);
  });

  test("does not retry a refusal and surfaces a visible assistant notice", async () => {
    let retries = 0;
    const events = await collect(retryEmptyAnthropicStream(
      streamOf([{ type: "done", stopReason: "refusal", usage: usage(20, 1) }]),
      async () => { retries++; return streamOf([]); },
    ));

    expect(retries).toBe(0);
    expect(events).toEqual([
      {
        type: "text_delta",
        text: "Anthropic declined to answer this request (stop_reason: refusal). Try a different prompt or model.",
      },
      { type: "done", stopReason: "refusal", usage: usage(20, 1) },
    ]);
  });

  test("fails visibly when the retry is also empty", async () => {
    const events = await retryEmptyAnthropicBatch(
      [{ type: "done", stopReason: "end_turn", usage: usage(30, 2) }],
      async () => [{ type: "done", stopReason: "end_turn", usage: usage(30, 4) }],
    );

    expect(events).toEqual([
      {
        type: "error",
        message: "Anthropic returned an empty response after one retry with adaptive thinking disabled (stop_reason: end_turn).",
        usage: usage(60, 6),
      },
    ]);
  });

  test("merges first-attempt usage into a retry-side error", async () => {
    const events = await collect(retryEmptyAnthropicStream(
      streamOf([{ type: "done", stopReason: "end_turn", usage: usage(30, 2) }]),
      async () => streamOf([{ type: "error", message: "retry stream failed", usage: usage(4, 1) }]),
    ));

    expect(events).toEqual([
      { type: "error", message: "retry stream failed", usage: usage(34, 3) },
    ]);
  });

  test("non-stream failed Responses JSON preserves billed retry usage", () => {
    const json = buildResponseJSON([
      { type: "error", message: "empty twice", usage: usage(60, 6) },
    ], "anthropic/claude-fable-5") as { status: string; usage: Record<string, unknown> };

    expect(json.status).toBe("failed");
    expect(json.usage).toMatchObject({ input_tokens: 60, output_tokens: 6, total_tokens: 66 });
  });

  test("recovery request disables reasoning without mutating the original", () => {
    const parsed = {
      modelId: "claude-fable-5",
      stream: true,
      options: { reasoning: "high", hideThinkingSummary: false },
      context: { messages: [] },
    } as unknown as OcxParsedRequest;

    const retry = anthropicEmptyRetryRequest(parsed);

    expect(retry.options.reasoning).toBe("none");
    expect(retry.options.hideThinkingSummary).toBe(false);
    expect(parsed.options.reasoning).toBe("high");
  });
});
