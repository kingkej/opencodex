import { isCanonicalOpenRouterTarget } from "../providers/openrouter-routing";
import { resolveProviderApiKey } from "../providers/api-key-resolve";
import type { OcxConfig } from "../types";
import type { JevDecisionEndpoint, ResolveJevDecisionOptions } from "./jev";

export const CLEF_API_URL = "https://openrouter.ai/api/alpha/decisions";
export const CLEF_MODEL = "cloudflare/clef";

/** Resolve the fixed Clef destination before reading any decision credential. */
export function clefDecisionEndpoint(
  config: OcxConfig,
  isDestinationAllowed?: ResolveJevDecisionOptions["isDestinationAllowed"],
): JevDecisionEndpoint | undefined | null {
  const configured = Object.hasOwn(config.providers, "openrouter") ? config.providers.openrouter : undefined;
  if (configured?.disabled) return undefined;
  if (isDestinationAllowed?.("openrouter", CLEF_MODEL) === false) return null;
  const ownsCredential = configured?.adapter === "openai-chat"
    && (configured.authMode === undefined || configured.authMode === "key")
    && isCanonicalOpenRouterTarget(configured.baseUrl);
  const apiKey = (ownsCredential ? resolveProviderApiKey(configured.apiKey)?.trim() : undefined)
    || process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return undefined;
  return {
    name: "openrouter",
    provider: ownsCredential ? configured : { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", authMode: "key" },
    url: CLEF_API_URL,
    model: CLEF_MODEL,
    apiKey,
    descriptiveCriteria: false,
  };
}
