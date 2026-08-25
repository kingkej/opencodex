import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { startVisibilityPoll } from "../visibility-poll";
import { createBoundedFetch } from "../bounded-fetch";
import { useT } from "../i18n/shared";
import type { NoticeTone } from "../ui";

type Feedback = { tone: NoticeTone; message: string } | null;

type PickerSettings = {
  codexAccountPickerEnabled: boolean;
  codexAccountPickerShowPoolModels: boolean;
};

type PickerSettingField = keyof PickerSettings;

/** Opt-in control for account-qualified Codex model-picker entries. */
export default function CodexAccountPickerSetting({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [settings, setSettings] = useState<PickerSettings>({
    codexAccountPickerEnabled: false,
    codexAccountPickerShowPoolModels: false,
  });
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<(NonNullable<Feedback> & { field: PickerSettingField }) | null>(null);
  const settingsRef = useRef<PickerSettings>(settings);
  const savingRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    if (savingRef.current) return;
    const generation = ++loadGenerationRef.current;
    const bounded = createBoundedFetch(15_000);
    try {
      const response = await fetch(`${apiBase}/api/settings`, { signal: bounded.signal });
      if (!response.ok) throw new Error("load");
      const payload = await response.json() as {
        codexAccountPickerEnabled?: unknown;
        codexAccountPickerShowPoolModels?: unknown;
      };
      if (savingRef.current || generation !== loadGenerationRef.current) return;
      if (typeof payload.codexAccountPickerEnabled !== "boolean"
        || (payload.codexAccountPickerShowPoolModels !== undefined
          && typeof payload.codexAccountPickerShowPoolModels !== "boolean")) {
        throw new Error("shape");
      }
      const confirmed = {
        codexAccountPickerEnabled: payload.codexAccountPickerEnabled,
        // Older servers omit this additive field. Their behavior matches the false default.
        codexAccountPickerShowPoolModels: payload.codexAccountPickerShowPoolModels ?? false,
      };
      settingsRef.current = confirmed;
      setSettings(confirmed);
      setHydrated(true);
      setLoadError(false);
    } catch {
      if (!savingRef.current && generation === loadGenerationRef.current) {
        setLoadError(true);
      }
    } finally {
      bounded.clear();
    }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    const stop = startVisibilityPoll(() => { void load(); }, 30_000);
    return () => {
      window.clearTimeout(timeout);
      stop();
    };
  }, [load]);

  const toggle = useCallback(async (field: PickerSettingField) => {
    if (savingRef.current || !hydrated) return;
    const previous = settingsRef.current;
    const requested = !previous[field];
    const optimistic: PickerSettings = { ...previous, [field]: requested };
    settingsRef.current = optimistic;
    setSettings(optimistic);
    savingRef.current = true;
    setSaving(true);
    setFeedback(null);
    loadGenerationRef.current += 1;
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: requested }),
      });
      const payload = (await readJsonOrThrow<{
        ok?: unknown;
        codexAccountPickerEnabled?: unknown;
        codexAccountPickerShowPoolModels?: unknown;
        catalogRefreshPending?: unknown;
      }>(response)) ?? {};
      if (payload.ok !== true
        || typeof payload.codexAccountPickerEnabled !== "boolean"
        || (payload.codexAccountPickerShowPoolModels !== undefined
          && typeof payload.codexAccountPickerShowPoolModels !== "boolean")
        || (field === "codexAccountPickerShowPoolModels"
          && payload.codexAccountPickerShowPoolModels === undefined)) {
        throw new Error("unconfirmed");
      }
      const confirmed = {
        codexAccountPickerEnabled: payload.codexAccountPickerEnabled,
        // A cached newer dashboard can still toggle the original picker against an older server.
        // Only a direct update of the new field requires that field to be echoed authoritatively.
        codexAccountPickerShowPoolModels:
          payload.codexAccountPickerShowPoolModels ?? previous.codexAccountPickerShowPoolModels,
      };
      settingsRef.current = confirmed;
      setSettings(confirmed);
      setHydrated(true);
      setLoadError(false);
      setFeedback(payload.catalogRefreshPending === true
        ? { field, tone: "warn", message: t("codexAuth.catalogRefreshPending") }
        : {
            field,
            tone: "ok",
            message: t(field === "codexAccountPickerEnabled"
              ? "codexAuth.accountPickerUpdated"
              : "codexAuth.accountPickerPoolModelsUpdated"),
          });
    } catch {
      settingsRef.current = previous;
      setSettings(previous);
      setFeedback({
        field,
        tone: "err",
        message: t(field === "codexAccountPickerEnabled"
          ? "codexAuth.accountPickerUpdateFailed"
          : "codexAuth.accountPickerPoolModelsUpdateFailed"),
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [apiBase, hydrated, t]);

  const initialLoadFailed = loadError && !hydrated;
  const enabled = settings.codexAccountPickerEnabled;
  const showPoolModels = settings.codexAccountPickerShowPoolModels;
  const primaryFeedback = feedback
    && (feedback.field === "codexAccountPickerEnabled" || !enabled)
    ? feedback
    : null;
  const poolModelsFeedback = feedback?.field === "codexAccountPickerShowPoolModels" && enabled
    ? feedback
    : null;

  return (
    <div>
      <div
        className="card card-row codex-account-picker-card"
        aria-busy={saving || (!hydrated && !initialLoadFailed) || undefined}
      >
        <div className="codex-account-picker-copy">
          <strong>{t("codexAuth.accountPickerTitle")}</strong>
          <div
            id="codex-account-picker-description"
            className="card-sub"
            role={initialLoadFailed ? "status" : undefined}
          >
            {initialLoadFailed
              ? t("codexAuth.accountPickerLoadFailed")
              : !hydrated
                ? t("common.loading")
                : t(enabled
                  ? "codexAuth.accountPickerOnDesc"
                  : "codexAuth.accountPickerOffDesc")}
          </div>
          {hydrated && enabled && (
            <div className="card-sub faint">{t("codexAuth.accountPickerCompatibility")}</div>
          )}
          {hydrated && loadError && (
            <div className="card-sub faint" role="status">
              {t("codexAuth.accountPickerRefreshFailed")}
            </div>
          )}
        </div>
        <div className="codex-account-picker-controls">
          {loadError && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => { void load(); }}
              disabled={saving}
            >
              {t("common.retry")}
            </button>
          )}
          {hydrated && (
            <button
              type="button"
              className={`toggle ${enabled ? "on" : ""}`}
              onClick={() => { void toggle("codexAccountPickerEnabled"); }}
              disabled={saving}
              aria-pressed={enabled}
              aria-label={t("codexAuth.accountPickerTitle")}
              aria-describedby="codex-account-picker-description"
              title={t("codexAuth.accountPickerTitle")}
            >
              <span className="toggle-knob" />
            </button>
          )}
        </div>
        {primaryFeedback && (
          <div
            className={`codex-account-picker-feedback is-${primaryFeedback.tone}`}
            role={primaryFeedback.tone === "err" ? "alert" : "status"}
            aria-atomic="true"
          >
            {primaryFeedback.message}
          </div>
        )}
      </div>

      {hydrated && enabled && (
        <div
          className="card card-row codex-account-picker-card"
          aria-busy={saving || undefined}
        >
          <div className="codex-account-picker-copy">
            <strong>{t("codexAuth.accountPickerPoolModelsTitle")}</strong>
            <div id="codex-account-picker-pool-models-description" className="card-sub">
              {t(showPoolModels
                ? "codexAuth.accountPickerPoolModelsOnDesc"
                : "codexAuth.accountPickerPoolModelsOffDesc")}
            </div>
          </div>
          <div className="codex-account-picker-controls">
            <button
              type="button"
              className={`toggle ${showPoolModels ? "on" : ""}`}
              onClick={() => { void toggle("codexAccountPickerShowPoolModels"); }}
              disabled={saving}
              aria-pressed={showPoolModels}
              aria-label={t("codexAuth.accountPickerPoolModelsTitle")}
              aria-describedby="codex-account-picker-pool-models-description"
              title={t("codexAuth.accountPickerPoolModelsTitle")}
            >
              <span className="toggle-knob" />
            </button>
          </div>
          {poolModelsFeedback && (
            <div
              className={`codex-account-picker-feedback is-${poolModelsFeedback.tone}`}
              role={poolModelsFeedback.tone === "err" ? "alert" : "status"}
              aria-atomic="true"
            >
              {poolModelsFeedback.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
