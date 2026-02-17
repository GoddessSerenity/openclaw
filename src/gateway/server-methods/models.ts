import { loadConfig } from "../../config/config.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      let models = await context.loadGatewayModelCatalog();
      const providers = params?.providers;
      if (Array.isArray(providers) && providers.length > 0) {
        const allowed = new Set(providers.map((p: string) => p.toLowerCase()));
        models = models.filter((m) => allowed.has(m.provider.toLowerCase()));
      }
      if (params?.configuredOnly) {
        const cfg = loadConfig();
        const configuredModels = cfg.agents?.defaults?.models;
        if (configuredModels && typeof configuredModels === "object") {
          const allowedIds = new Set(Object.keys(configuredModels).map((k) => k.toLowerCase()));
          models = models.filter((m) => {
            const fullId = `${m.provider}/${m.id}`.toLowerCase();
            return allowedIds.has(fullId);
          });
        }
      }
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
