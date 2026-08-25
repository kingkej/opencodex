/**
 * Is Codex's dedicated reviewer (`codex-auto-review`) reachable right now?
 *
 * `codex-auto-review` is a native OpenAI control-plane id: the router pins it to the canonical
 * `openai` provider (CODEX_INTERNAL_OPENAI_MODELS), so it can only be served by a usable ChatGPT
 * account. Routed catalog entries advertise it via `auto_review_model_override` so a session whose
 * primary model is Anthropic/xAI still reviews with Codex's own reviewer instead of leaking the
 * approval transcript to a third-party provider.
 *
 * When the native account is exhausted that pin becomes a hard stop: every approval fails with a
 * 429 even though the session's own provider is healthy. Observed 2026-08-17 — an exhausted weekly
 * quota 429'd `codex-auto-review` while Anthropic served turns normally, which blocks approvals for
 * as long as the quota window lasts.
 *
 * So the reviewer is re-pointed at a configured routed model while it cannot answer. The router
 * does this at request time (not via the catalog's `auto_review_model_override`, which is written
 * to disk at sync time and would freeze a stale decision until the next sync).
 *
 * Fail-open on an unreadable/absent account: that is the pre-existing Direct/passthrough shape
 * where the caller supplies its own bearer, and suppressing the override there would silently
 * change reviewer behavior for a working setup. Only positive evidence that the reviewer cannot
 * answer — a stored-but-expired main token, or a live quota cooldown — drops the override.
 */
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { readCodexTokensResult } from "./auth-collision";
import { getMainAccountPlan, isMainAccountTokenLive } from "./main-account";
import { isCodexQuotaExhausted, readPersistedAccountQuota } from "./quota";
import { codexQuotaScopeForModel, getCodexQuotaHealthSnapshot } from "./routing";
import { getProviderRegistryEntry } from "../providers/registry";
import type { OcxConfig } from "../types";

/** Native reviewer id. Kept here so the catalog and the availability check cannot drift apart. */
export const CODEX_AUTO_REVIEW_MODEL_ID = "codex-auto-review";

/**
 * Provider preference for a stand-in reviewer, most capable first.
 *
 * Only providers that authenticate independently of the ChatGPT account qualify — routing the
 * reviewer to another native OpenAI id would inherit the exact quota that just failed.
 */
const REVIEWER_FALLBACK_PROVIDERS = ["anthropic", "xai"] as const;

function normalizedReviewerEndpoint(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Reviewer traffic may contain approval context, so a familiar provider name is not enough.
 * Require the configured row to retain the registry's canonical transport and an independently
 * authenticated mode that the preset actually supports. In particular, Anthropic deliberately
 * allows custom base URLs for enterprise gateways; those are valid ordinary routes but must not
 * become an implicit reviewer destination during a native Codex outage.
 */
function isTrustedReviewerFallbackProvider(
  name: (typeof REVIEWER_FALLBACK_PROVIDERS)[number],
  provider: NonNullable<OcxConfig["providers"]>[string],
): boolean {
  const entry = getProviderRegistryEntry(name);
  if (!entry || provider.adapter !== entry.adapter) return false;

  const configuredEndpoint = normalizedReviewerEndpoint(provider.baseUrl);
  const canonicalEndpoint = normalizedReviewerEndpoint(entry.baseUrl);
  if (!configuredEndpoint || configuredEndpoint !== canonicalEndpoint) return false;

  const authMode = provider.authMode ?? entry.authKind;
  if (authMode === "oauth") return entry.authKind === "oauth";
  if (authMode === "key") {
    return entry.authKind === "key" || entry.allowKeyAuthOverride === true;
  }
  return false;
}

/**
 * A configured, enabled stand-in reviewer, or null when none qualifies.
 *
 * Returns the provider's own default model so the choice follows the user's configuration rather
 * than a hardcoded model id that may not be entitled on their account.
 */
export function reviewerFallbackModelId(config: OcxConfig): string | null {
  for (const name of REVIEWER_FALLBACK_PROVIDERS) {
    const provider = config.providers?.[name];
    if (!provider || provider.disabled === true) continue;
    if (!isTrustedReviewerFallbackProvider(name, provider)) continue;
    const model = provider.defaultModel;
    if (typeof model !== "string" || model.length === 0) continue;
    // Namespaced so the router resolves it through the explicit-provider path and cannot
    // re-enter the native-family pin this fallback exists to escape.
    return `${name}/${model}`;
  }
  return null;
}

export function nativeCodexReviewerUsable(now = Date.now()): boolean {
  // Distinguish "no stored login" from "stored login that is dead".
  //
  // `missing`/`invalid`/`unreadable` is the Direct/passthrough shape (and every test fixture and
  // fresh install): the caller brings its own bearer, so the reviewer may well be reachable and
  // suppressing the override here would change reviewer behavior for a working setup. Only a
  // stored-and-expired token is positive evidence that pooled native auth cannot be materialized.
  try {
    if (readCodexTokensResult().status === "ok" && !isMainAccountTokenLive(now)) return false;
  } catch {
    return true;
  }

  try {
    // Scope matters: a reset-derived 429 can belong to one native quota group. Ask about the
    // reviewer's own group so an unrelated group's cooldown never suppresses the override.
    const scope = codexQuotaScopeForModel(CODEX_AUTO_REVIEW_MODEL_ID);
    if (getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, scope, now) !== null) return false;
  } catch {
    return true;
  }

  // Neither check above survives Direct mode, which is why the cooldown ledger alone was not
  // enough. Both are fed by `recordCodexUpstreamOutcome`/`applyAccountQuotaFromUpstreamHeaders`,
  // and BOTH call sites are gated on `usesCodexForwardPoolAuth` — true only for a `pool`/
  // `main-pool` auth context. Direct resolves to `{ kind: "main", accountId: null }`, and
  // `recordCodexUpstreamOutcome` returns early on a null account, so a Direct 429 arms nothing.
  //
  // Observed 2026-08-18: with `codexAccountMode: direct` the reviewer 429'd repeatedly while the
  // ledger stayed empty and the cached bar sat at 100% — the account was provably exhausted and
  // every in-memory signal said "healthy".
  //
  // The persisted bar is the one piece of evidence that outlives both the process and the mode.
  try {
    // Deliberately the un-aged read: under Direct nothing refreshes this row, so the ordinary
    // six-hour freshness gate would age a known 100% into "unknown" and silently restore the 429
    // loop. A reset still in the future is what keeps the stale reading meaningful.
    const quota = readPersistedAccountQuota(MAIN_CODEX_ACCOUNT_ID);
    // The plan selects the governing window (weekly vs 30-day). Direct never populates it, so
    // this defaults to weekly; a Go/Free account with an uncached plan would then read the wrong
    // window and miss exhaustion. That direction fails open — native stays selected — which is
    // the safe way to be wrong here.
    if (!quota || !isCodexQuotaExhausted(quota, getMainAccountPlan())) return true;
    // A stale 100% reading must not pin the reviewer away forever. Once the reported reset time
    // has passed, the cached bar is expired evidence: fall back to native and let a real upstream
    // response (success, or a fresh 429 that re-arms the ledger) settle it.
    //
    // An exhausted row carrying NO reset timestamp is treated the same way (nothing is pending,
    // so this returns usable). That is deliberate: without a reset there is no proof the window
    // is still open, and pinning the reviewer away on unbounded evidence would be permanent.
    return !codexQuotaResetPending(quota, now);
  } catch {
    return true;
  }
}

/** Seconds-or-milliseconds epoch, matching the mixed units upstream sends. */
function resetAtMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 10_000_000_000 ? value * 1000 : value;
}

/** True while at least one exhausted window still reports a reset in the future. */
function codexQuotaResetPending(
  quota: { weeklyResetAt?: number; monthlyResetAt?: number; shortResetAt?: number },
  now: number,
): boolean {
  return [quota.weeklyResetAt, quota.monthlyResetAt, quota.shortResetAt]
    .map(resetAtMs)
    .some(value => value !== undefined && value > now);
}
