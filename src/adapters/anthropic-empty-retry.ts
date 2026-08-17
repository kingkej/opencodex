import type { AdapterEvent, OcxParsedRequest, OcxUsage } from "../types";

const RETRYABLE_EMPTY_STOP_REASONS = new Set(["end_turn", "max_tokens"]);

function hasAnswerOrAction(event: AdapterEvent): boolean {
  if (event.type === "text_delta") return event.text.trim().length > 0;
  return event.type === "tool_call_start"
    || event.type === "web_search_call_begin"
    || event.type === "web_search_call_end";
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

export function mergeAnthropicRetryUsage(first: OcxUsage | undefined, second: OcxUsage | undefined): OcxUsage | undefined {
  if (!first) return second;
  if (!second) return first;
  const inputTokens = first.inputTokens + second.inputTokens;
  const outputTokens = first.outputTokens + second.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(sumOptional(first.cachedInputTokens, second.cachedInputTokens) !== undefined
      ? { cachedInputTokens: sumOptional(first.cachedInputTokens, second.cachedInputTokens)! }
      : {}),
    ...(sumOptional(first.cacheReadInputTokens, second.cacheReadInputTokens) !== undefined
      ? { cacheReadInputTokens: sumOptional(first.cacheReadInputTokens, second.cacheReadInputTokens)! }
      : {}),
    ...(sumOptional(first.cacheCreationInputTokens, second.cacheCreationInputTokens) !== undefined
      ? { cacheCreationInputTokens: sumOptional(first.cacheCreationInputTokens, second.cacheCreationInputTokens)! }
      : {}),
    ...(sumOptional(first.reasoningOutputTokens, second.reasoningOutputTokens) !== undefined
      ? { reasoningOutputTokens: sumOptional(first.reasoningOutputTokens, second.reasoningOutputTokens)! }
      : {}),
    ...(first.estimated || second.estimated ? { estimated: true } : {}),
  };
}

function stopReasonLabel(stopReason: string | undefined): string {
  return stopReason?.trim() || "missing";
}

function emptyFailure(stopReason: string | undefined, usage?: OcxUsage, retried = false): AdapterEvent {
  const label = stopReasonLabel(stopReason);
  const suffix = retried ? " after one retry with adaptive thinking disabled" : "";
  return {
    type: "error",
    message: `Anthropic returned an empty response${suffix} (stop_reason: ${label}).`,
    ...(usage ? { usage } : {}),
  };
}

function shouldRetry(stopReason: string | undefined): boolean {
  return stopReason === undefined || RETRYABLE_EMPTY_STOP_REASONS.has(stopReason);
}

function refusalNotice(): AdapterEvent {
  return {
    type: "text_delta",
    text: "Anthropic declined to answer this request (stop_reason: refusal). Try a different prompt or model.",
  };
}

/**
 * Retry a successful-but-empty Anthropic turn once. Events from the first attempt are streamed
 * normally, but its terminal `done` is held until we know whether a retry is necessary.
 */
export async function* retryEmptyAnthropicStream(
  first: AsyncIterable<AdapterEvent>,
  retry: () => Promise<AsyncIterable<AdapterEvent>>,
): AsyncGenerator<AdapterEvent> {
  let firstDone: Extract<AdapterEvent, { type: "done" }> | undefined;
  let firstAnswered = false;

  for await (const event of first) {
    if (hasAnswerOrAction(event)) firstAnswered = true;
    if (event.type === "done") {
      firstDone = event;
      break;
    }
    yield event;
    if (event.type === "error") return;
  }

  if (firstAnswered) {
    if (firstDone) yield firstDone;
    else yield emptyFailure(undefined);
    return;
  }

  if (!shouldRetry(firstDone?.stopReason)) {
    if (firstDone?.stopReason === "refusal") {
      yield refusalNotice();
      yield firstDone;
      return;
    }
    yield emptyFailure(firstDone?.stopReason, firstDone?.usage);
    return;
  }

  let retryEvents: AsyncIterable<AdapterEvent>;
  try {
    retryEvents = await retry();
  } catch (error) {
    yield {
      type: "error",
      message: `Anthropic empty-response retry failed: ${error instanceof Error ? error.message : String(error)}`,
      ...(firstDone?.usage ? { usage: firstDone.usage } : {}),
    };
    return;
  }

  let retryDone: Extract<AdapterEvent, { type: "done" }> | undefined;
  let retryAnswered = false;
  for await (const event of retryEvents) {
    if (hasAnswerOrAction(event)) retryAnswered = true;
    if (event.type === "done") {
      retryDone = event;
      break;
    }
    if (event.type === "error") {
      const usage = mergeAnthropicRetryUsage(firstDone?.usage, event.usage);
      yield { ...event, ...(usage ? { usage } : {}) };
      return;
    }
    yield event;
  }

  const usage = mergeAnthropicRetryUsage(firstDone?.usage, retryDone?.usage);
  if (!retryAnswered) {
    yield emptyFailure(retryDone?.stopReason, usage, true);
    return;
  }
  if (!retryDone) {
    yield emptyFailure(undefined, usage, true);
    return;
  }
  yield { ...retryDone, ...(usage ? { usage } : {}) };
}

export async function retryEmptyAnthropicBatch(
  first: AdapterEvent[],
  retry: () => Promise<AdapterEvent[]>,
): Promise<AdapterEvent[]> {
  async function* fromArray(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
    yield* events;
  }
  const out: AdapterEvent[] = [];
  for await (const event of retryEmptyAnthropicStream(fromArray(first), async () => fromArray(await retry()))) {
    out.push(event);
  }
  return out;
}

/** Disable Anthropic adaptive thinking for the one-shot empty-response recovery attempt. */
export function anthropicEmptyRetryRequest(parsed: OcxParsedRequest): OcxParsedRequest {
  return {
    ...parsed,
    options: { ...parsed.options, reasoning: "none" },
  };
}
