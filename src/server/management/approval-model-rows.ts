import { CODEX_INTERNAL_OPENAI_MODELS } from "../../codex/control-plane-models";
import { codexControlPlaneModelCapabilities } from "../../codex/catalog/control-plane-capabilities";
import { providerContextCap } from "../../providers/context-cap";
import type { OcxConfig } from "../../types";
import type { ManagementModelRow } from "./model-rows";

/** Internal Combo inventory only; never expands the public native model roster. */
export function internalApprovalModelRows(
  config: OcxConfig,
  include: boolean | undefined,
): ManagementModelRow[] {
  if (include !== true) return [];
  return [...CODEX_INTERNAL_OPENAI_MODELS].flatMap(id => {
    const capabilities = codexControlPlaneModelCapabilities(
      "openai", config.providers.openai, id, providerContextCap(config, "openai"),
    );
    if (!capabilities) return [];
    return [{
      ...capabilities,
      provider: "openai",
      id,
      namespaced: id,
      native: true,
      internalApproval: true,
      disabled: false,
    }];
  });
}
