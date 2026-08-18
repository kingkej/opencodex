import { afterEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import * as authCollision from "../src/codex/auth-collision";
import * as mainAccount from "../src/codex/main-account";
import {
  CODEX_AUTO_REVIEW_MODEL_ID,
  nativeCodexReviewerUsable,
  reviewerFallbackModelId,
} from "../src/codex/reviewer-availability";
import {
  clearCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../src/codex/quota";
import { getConfigDir } from "../src/config";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

/**
 * Write the on-disk quota cache directly.
 *
 * `setAccountQuotaFromParsed` always stamps `updatedAt` with the current time, so it cannot
 * express the state under test here: a row old enough to be aged out by the hydrate path.
 * `tests/preload.ts` sandboxes OPENCODEX_HOME, so this touches only the test home.
 */
function writeQuotaCacheFile(quota: Record<string, number>): void {
  clearAccountQuota();
  writeFileSync(
    join(getConfigDir(), "codex-quota-cache.json"),
    `${JSON.stringify({ version: 1, quotas: { [MAIN_CODEX_ACCOUNT_ID]: quota } })}\n`,
  );
}

/** Minimal config: only the failover threshold is read on the 429 path exercised here. */
const config = { providers: {}, upstreamFailoverThreshold: 3 } as unknown as OcxConfig;

/** Mirrors the user's live shape: native OpenAI plus an independently-authenticated Anthropic. */
function routableConfig(): OcxConfig {
  return {
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        defaultModel: "claude-sonnet-5",
        models: ["claude-sonnet-5"],
      },
    },
    upstreamFailoverThreshold: 3,
  } as unknown as OcxConfig;
}

/**
 * Approvals must survive an exhausted native Codex quota.
 *
 * `codex-auto-review` is pinned to the canonical `openai` provider, so stamping
 * `auto_review_model_override` unconditionally turned one account's 429 into a hard stop on every
 * approval — including sessions whose primary model was a healthy Anthropic/xAI route
 * (observed 2026-08-17). These tests pin the conditional behavior in both directions.
 */
describe("native Codex reviewer availability", () => {
  // Explicit restore: `using` disposal is not supported by the spy objects in this Bun version,
  // and a leaked module spy silently changes the result of every later test in the file.
  const spies: Mock<(...args: never[]) => unknown>[] = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    clearCodexUpstreamHealth();
    clearAccountQuota();
  });

  function track<T extends Mock<(...args: never[]) => unknown>>(spy: T): T {
    spies.push(spy);
    return spy;
  }

  test("reviewer is usable when no main token is stored (Direct/passthrough shape)", () => {
    track(spyOn(authCollision, "readCodexTokensResult") as never)
      .mockReturnValue({ status: "missing" });

    // Absence of a stored login is not evidence the reviewer is unreachable: a Direct caller
    // supplies its own bearer. Suppressing here would change behavior for a working setup.
    expect(nativeCodexReviewerUsable()).toBe(true);
  });

  test("a stored-but-expired main token makes the reviewer unusable", () => {
    track(spyOn(authCollision, "readCodexTokensResult") as never).mockReturnValue({
      status: "ok",
      tokens: { access_token: "stored", account_id: "acct" },
    });
    track(spyOn(mainAccount, "isMainAccountTokenLive") as never).mockReturnValue(false);

    expect(nativeCodexReviewerUsable()).toBe(false);
  });

  test("a live quota cooldown on the main account makes the reviewer unusable", () => {
    expect(nativeCodexReviewerUsable()).toBe(true);

    // Exactly the shape seen in production: an upstream 429 that opens a cooldown window.
    recordCodexUpstreamOutcome(config, MAIN_CODEX_ACCOUNT_ID, 429, { retryAfter: "600" });

    expect(nativeCodexReviewerUsable()).toBe(false);
  });

  test("the reviewer becomes usable again once the cooldown window elapses", () => {
    recordCodexUpstreamOutcome(config, MAIN_CODEX_ACCOUNT_ID, 429, { retryAfter: "600" });
    expect(nativeCodexReviewerUsable()).toBe(false);

    // Recovery must be automatic — no restart, no manual clear-cooldown.
    expect(nativeCodexReviewerUsable(Date.now() + 11 * 60_000)).toBe(true);
  });

  test("fallback prefers a configured, independently-authenticated provider", () => {
    expect(reviewerFallbackModelId(routableConfig())).toBe("anthropic/claude-sonnet-5");

    // Nothing eligible: no fallback rather than an invented model id.
    expect(reviewerFallbackModelId({ providers: {} } as unknown as OcxConfig)).toBeNull();

    // A disabled provider is not a candidate.
    const disabled = routableConfig();
    disabled.providers.anthropic!.disabled = true;
    expect(reviewerFallbackModelId(disabled)).toBeNull();
  });

  test("the reviewer routes natively while the account is healthy", () => {
    const routable = routableConfig();

    const route = routeModel(routable, CODEX_AUTO_REVIEW_MODEL_ID);

    // The whole point of the override: approvals stay on Codex's own reviewer by default.
    expect(route.providerName).toBe("openai");
    expect(route.modelId).toBe(CODEX_AUTO_REVIEW_MODEL_ID);
  });

  test("an exhausted native quota reroutes the reviewer instead of failing the approval", () => {
    const routable = routableConfig();
    recordCodexUpstreamOutcome(routable, MAIN_CODEX_ACCOUNT_ID, 429, { retryAfter: "600" });

    const route = routeModel(routable, CODEX_AUTO_REVIEW_MODEL_ID);

    // This is the regression: it used to stay pinned to openai and 429 every approval.
    expect(route.providerName).toBe("anthropic");
    expect(route.modelId).toBe("claude-sonnet-5");
    expect(route.routeReason).toBe("reviewer-fallback-native-unusable");
  });

  test("with no eligible fallback the reviewer stays native and surfaces the upstream error", () => {
    const openaiOnly = routableConfig();
    delete openaiOnly.providers.anthropic;
    recordCodexUpstreamOutcome(openaiOnly, MAIN_CODEX_ACCOUNT_ID, 429, { retryAfter: "600" });

    const route = routeModel(openaiOnly, CODEX_AUTO_REVIEW_MODEL_ID);

    // Better a truthful upstream 429 than a silently different failure shape.
    expect(route.providerName).toBe("openai");
    expect(route.modelId).toBe(CODEX_AUTO_REVIEW_MODEL_ID);
  });

  /**
   * The in-memory cooldown ledger does not survive `ocx` restarting, but the upstream quota
   * window does. Observed 2026-08-18: restarting the proxy to pick up this fix cleared the
   * ledger, and approvals immediately resumed 429ing against an account still reported at 100%
   * with two days left on its weekly window.
   */
  describe("durable quota evidence (survives a proxy restart)", () => {
    /** A reported-exhausted weekly window whose reset is still in the future. */
    function storeExhaustedWeeklyQuota(resetAtSeconds: number): void {
      setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, {
        weeklyPercent: 100,
        weeklyResetAt: resetAtSeconds,
      });
    }

    test("a cached 100% weekly bar makes the reviewer unusable with an empty cooldown ledger", () => {
      // No recordCodexUpstreamOutcome call: this is precisely the post-restart state.
      expect(nativeCodexReviewerUsable()).toBe(true);

      storeExhaustedWeeklyQuota(Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60);

      expect(nativeCodexReviewerUsable()).toBe(false);
    });

    test("approvals reroute after a restart rather than 429ing again", () => {
      const routable = routableConfig();
      storeExhaustedWeeklyQuota(Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60);

      const route = routeModel(routable, CODEX_AUTO_REVIEW_MODEL_ID);

      expect(route.providerName).toBe("anthropic");
      expect(route.routeReason).toBe("reviewer-fallback-native-unusable");
    });

    test("a cached bar whose reset has passed is expired evidence, not a permanent pin", () => {
      const resetAtSeconds = Math.floor(Date.now() / 1000) + 60;
      storeExhaustedWeeklyQuota(resetAtSeconds);
      expect(nativeCodexReviewerUsable()).toBe(false);

      // Past the reported reset the stale 100% must stop suppressing the native reviewer,
      // otherwise a cache that never refreshes would pin approvals away from Codex forever.
      expect(nativeCodexReviewerUsable(resetAtSeconds * 1000 + 60_000)).toBe(true);
    });

    test("a cached bar below 100% leaves the reviewer native", () => {
      setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, {
        weeklyPercent: 99,
        weeklyResetAt: Math.floor(Date.now() / 1000) + 3600,
      });

      expect(nativeCodexReviewerUsable()).toBe(true);
    });

    /**
     * Direct mode never refreshes the quota row: both writers are gated on
     * `usesCodexForwardPoolAuth`, which is false for a Direct auth context. So the persisted bar
     * ages past the six-hour freshness gate and stays there.
     *
     * Observed 2026-08-18: a 6.16-hour-old 100% reading aged out to "unknown", the reviewer was
     * declared healthy, and approvals resumed 429ing with two days left on the window.
     */
    test("an aged-out 100% bar still suppresses the reviewer while its reset is pending", () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      writeQuotaCacheFile({
        // Older than QUOTA_DISK_MAX_AGE_MS (6h), so the ordinary hydrate path discards it.
        updatedAt: Date.now() - 7 * 60 * 60_000,
        weeklyPercent: 100,
        weeklyResetAt: nowSeconds + 2 * 24 * 60 * 60,
      });

      // Usage inside a window only climbs until the window turns over, so an old 100% cannot
      // have become healthy. Ageing it out is what silently restored the 429 loop.
      expect(nativeCodexReviewerUsable()).toBe(false);
    });

    test("an aged-out bar whose reset has passed does not pin the reviewer", () => {
      const resetAtSeconds = Math.floor(Date.now() / 1000) - 60;
      writeQuotaCacheFile({
        updatedAt: Date.now() - 7 * 60 * 60_000,
        weeklyPercent: 100,
        weeklyResetAt: resetAtSeconds,
      });

      expect(nativeCodexReviewerUsable()).toBe(true);
    });
  });
});
