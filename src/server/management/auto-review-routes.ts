import { jsonResponse } from "../auth-cors";
import { deleteConfigTopLevelKey } from "../../config/rebase-provenance";
import { saveConfigPreservingClaudeCode } from "../../config/live-reconcile";
import { autoReviewModelTargetConfigError } from "../../config/provider-validation";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import { loadExportModels } from "./model-rows";
import { isPlainRecord } from "./shared";

/**
 * /api/auto-review-model — the dashboard's auto-review (approval) reviewer selector.
 *
 * A PUT manages exactly one thing: the `codex-auto-review` entry in
 * `blockedModelRedirects`. The shared routing layer applies that entry to every review
 * request that names the control-plane slug, and the management route mutates the live
 * config object the router shares by reference — so the switch is HOT: the next review
 * request is rerouted, with no Codex restart, no catalog convergence, and no write into
 * Codex's own config.toml. The selector is resolved against the export catalog at write
 * time so the UI gets an immediate 400 instead of a silent dead redirect.
 *
 * The root `auto_review_model` stamp in Codex's config.toml stays a separate, manual
 * mechanism this route deliberately does not touch: it needs an app-server reload to
 * matter, which is exactly the restart this panel exists to avoid.
 */
const REVIEWER_REDIRECT_KEY = "codex-auto-review";

export async function handleAutoReviewRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps } = ctx;
  if (url.pathname !== "/api/auto-review-model") return null;

  if (req.method === "GET") {
    return jsonResponse({
      autoReviewModel: config.blockedModelRedirects?.[REVIEWER_REDIRECT_KEY] ?? null,
    });
  }
  if (req.method !== "PUT") return null;

  let parsedBody: unknown;
  try { parsedBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
  if (!isPlainRecord(parsedBody) || !Object.hasOwn(parsedBody, "model")) {
    return jsonResponse({ error: "model (catalog selector string or null) is required" }, 400);
  }
  const raw = parsedBody.model;
  if (raw !== null && typeof raw !== "string") {
    return jsonResponse({ error: "model must be a catalog selector string or null" }, 400);
  }
  const selector = raw === null ? null : raw.trim();
  if (selector === "") {
    return jsonResponse({ error: "model must be a non-empty catalog selector or null" }, 400);
  }
  if (selector !== null && autoReviewModelTargetConfigError(selector) !== null) {
    return jsonResponse({ error: "model is not a valid catalog selector" }, 400);
  }
  if (selector !== null) {
    const models = await loadExportModels(config);
    if (!models.some(model => model.namespaced === selector)) {
      return jsonResponse({ error: `model \${selector} is not in the current catalog` }, 400);
    }
  }

  if (selector === null) {
    const redirects = { ...(config.blockedModelRedirects ?? {}) };
    delete redirects[REVIEWER_REDIRECT_KEY];
    if (Object.keys(redirects).length > 0) config.blockedModelRedirects = redirects;
    else deleteConfigTopLevelKey(config, "blockedModelRedirects");
  } else {
    config.blockedModelRedirects = { ...(config.blockedModelRedirects ?? {}), [REVIEWER_REDIRECT_KEY]: selector };
  }
  (deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(config);
  return jsonResponse({
    ok: true,
    autoReviewModel: selector,
  });
}
