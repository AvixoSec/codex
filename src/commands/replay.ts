import { dirname } from "node:path";

import { ReceiptStore, type ReceiptRecord } from "../receipts/store.js";

export interface ReplayRoute {
  step: number;
  target?: string;
  action?: string;
  effort?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  toolPolicy?: string;
}

export interface ReplayResult {
  records: ReceiptRecord[];
  routes: ReplayRoute[];
  status?: string;
  finalText?: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function replayReceipts(path: string): Promise<ReplayResult> {
  const store = new ReceiptStore(dirname(path));
  const records = await store.read(path);
  const routes = records.flatMap((record): ReplayRoute[] => {
    if (record.kind !== "route" || !object(record.resolved) || typeof record.step !== "number") return [];
    const resolved = record.resolved;
    return [{
      step: record.step,
      ...(typeof resolved.target === "string" ? { target: resolved.target } : {}),
      ...(typeof resolved.action === "string" ? { action: resolved.action } : {}),
      ...(typeof resolved.effort === "string" ? { effort: resolved.effort } : {}),
      ...(typeof resolved.contextTokens === "number" ? { contextTokens: resolved.contextTokens } : {}),
      ...(typeof resolved.maxOutputTokens === "number" ? { maxOutputTokens: resolved.maxOutputTokens } : {}),
      ...(typeof resolved.toolPolicy === "string" ? { toolPolicy: resolved.toolPolicy } : {})
    }];
  });
  const final = [...records].reverse().find((record) => record.kind === "run_finished");
  return {
    records,
    routes,
    ...(typeof final?.status === "string" ? { status: final.status } : {}),
    ...(typeof final?.finalText === "string" ? { finalText: final.finalText } : {})
  };
}
