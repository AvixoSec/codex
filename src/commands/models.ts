import { loadConfig } from "../config/load.js";
import { listTargets } from "../config/schema.js";

export interface ModelRow {
  target: string;
  apiModel: string;
  baseUrl: string;
  api: string;
  context: number;
  output: number;
  efforts: string;
  tools: boolean;
  temperature: string;
}

export async function listModels(path: string): Promise<ModelRow[]> {
  const { config } = await loadConfig(path);
  return listTargets(config).map((target) => ({
    target: target.id,
    apiModel: target.apiModel,
    baseUrl: target.baseUrl,
    api: target.api,
    context: target.model.contextWindow,
    output: target.model.maxOutputTokens,
    efforts: target.model.efforts.join(","),
    tools: target.model.supportsTools,
    temperature: target.model.temperature === false
      ? "unsupported"
      : target.model.temperature.min + ".." + target.model.temperature.max
  }));
}
