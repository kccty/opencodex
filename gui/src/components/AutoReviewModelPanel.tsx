import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { IconAlert } from "../icons";
import { Select } from "../ui";
import { createBoundedFetch } from "../bounded-fetch";
import { requireJson, type ModelInfo } from "../pages/dashboard-shared";
import { formatNamespacedModelId } from "../provider-icons";

/**
 * The auto-review (approval) reviewer selector. A save manages the proxy-side reroute
 * for review requests on the live config the router shares, so a switch here is HOT:
 * the next review is routed to the selected model without restarting Codex.
 */
export default function AutoReviewModelPanel(props: { apiBase: string; models: ModelInfo[] }) {
  return <AutoReviewModelControls key={props.apiBase} {...props} />;
}

function AutoReviewModelControls({ apiBase, models }: { apiBase: string; models: ModelInfo[] }) {
  const t = useT();
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  const active = useRef(false);
  const pending = useRef<ReturnType<typeof createBoundedFetch> | null>(null);

  const accept = useCallback((next: string | null) => {
    setSaved(next);
    setValue(next ?? "");
  }, []);

  const load = useCallback(async () => {
    if (pending.current) return;
    const request = createBoundedFetch(15_000);
    pending.current = request;
    setLoadError(false);
    try {
      const response = await fetch(`${apiBase}/api/auto-review-model`, { signal: request.signal });
      const body = await requireJson(response) as { autoReviewModel?: unknown };
      if (!active.current || pending.current !== request) return;
      if (body.autoReviewModel !== null && typeof body.autoReviewModel !== "string") throw new Error("invalid settings");
      accept(body.autoReviewModel ?? null);
    } catch {
      if (active.current && pending.current === request) setLoadError(true);
    } finally {
      request.clear();
      if (pending.current === request) pending.current = null;
    }
  }, [apiBase, accept]);

  useEffect(() => {
    active.current = true;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => {
      window.clearTimeout(timer);
      active.current = false;
      pending.current?.controller.abort();
      pending.current?.clear();
      pending.current = null;
    };
  }, [load]);

  const save = async () => {
    if (pending.current || saved === undefined) return;
    const request = createBoundedFetch(15_000);
    pending.current = request;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`${apiBase}/api/auto-review-model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: value || null }),
        signal: request.signal,
      });
      const body = await requireJson(response) as { autoReviewModel?: unknown };
      if (!response.ok) throw new Error("save failed");
      const savedModel = body.autoReviewModel;
      if (savedModel !== null && typeof savedModel !== "string") throw new Error("invalid response");
      if (active.current && pending.current === request) {
        accept(savedModel ?? null);
        setFeedback("saved");
      }
    } catch {
      if (active.current && pending.current === request) setFeedback("failed");
    } finally {
      request.clear();
      if (pending.current === request) pending.current = null;
      setBusy(false);
    }
  };

  const options = [{ value: "", label: t("autoReviewModel.default") },
    ...[...new Set([...models.map(item => item.namespaced), ...[value].filter(Boolean)])]
      .map(candidate => ({ value: candidate, label: formatNamespacedModelId(candidate, t) }))];
  const disabled = busy || saved === undefined || loadError;
  const dirty = value !== (saved ?? "");

  return (
    <section className="panel" aria-labelledby="auto-review-model-title" aria-busy={busy || (saved === undefined && !loadError)}>
      <div className="font-semibold" id="auto-review-model-title">{t("autoReviewModel.title")}</div>
      <div className="muted setting-hint">{t("autoReviewModel.description")}</div>
      <div className="spread" style={{ alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        <div style={{ flex: "1 1 18rem", minWidth: 0 }} />
        <div className="memory-models-controls">
          <Select id="auto-review-model" value={value} options={options} disabled={disabled}
            label={t("autoReviewModel.title")}
            onChange={next => { setValue(next); setFeedback(null); }} />
          <button type="button" className="btn btn-primary btn-sm" disabled={disabled || !dirty} onClick={() => { void save(); }}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
      {loadError && <div className="notice notice-err" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>{t("autoReviewModel.loadFailed")} <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>{t("common.retry")}</button></div>}
      {feedback === "failed" && <div className="notice notice-err" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
        <IconAlert width={14} /> {t("autoReviewModel.saveFailed")}
      </div>}
      {feedback === "saved" && <div className="muted setting-hint" role="status">{t("autoReviewModel.saved")}</div>}
    </section>
  );
}
