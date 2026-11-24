import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { leadModels, qualifiedModel, type DoriConfig, type LeadModel } from "./config.ts";
import { isRecord, readJsonState } from "./durable-write.ts";

export type LeadRestartRequest = {
  readonly id: string;
  readonly at: number;
  readonly models: readonly LeadModel[];
};

const path = (stateDir: string): string => join(stateDir, "lead-restart.json");

const isRequest = (v: unknown): v is LeadRestartRequest =>
  isRecord(v) && typeof v.id === "string" && typeof v.at === "number" && Array.isArray(v.models) && v.models.every((m) => isRecord(m) && typeof m.model === "string");

/** A corrupt request is moved aside and read as none: the restart it asked for does not happen. */
export const pendingLeadRestart = (stateDir: string): LeadRestartRequest | undefined =>
  readJsonState(path(stateDir), "LEAD_RESTART", isRequest, "no pending lead restart; request it again");

export const requestLeadRestart = (config: DoriConfig, at: number, model?: string, thinking?: string): LeadRestartRequest => {
  const models = leadModels(config);
  // A bare --model is stored with the configured lead or default model's provider, the form the soft restart compares
  // with a session's model and types into /model.
  const qualified = model && qualifiedModel(model, undefined, [models[0]?.model, config.defaultModel]);
  const request: LeadRestartRequest = {
    id: randomUUID(), at,
    models: qualified ? [{ model: qualified, ...(thinking || models[0]?.thinking ? { thinking: thinking || models[0]?.thinking } : {}) }]
      : thinking ? models.map((entry) => ({ ...entry, thinking })) : models,
  };
  mkdirSync(config.stateDir, { recursive: true });
  const tmp = `${path(config.stateDir)}.${request.id}.tmp`;
  writeFileSync(tmp, JSON.stringify(request), { mode: 0o600, flush: true });
  renameSync(tmp, path(config.stateDir));
  return request;
};

export const completeLeadRestart = (stateDir: string, id: string): void => {
  if (pendingLeadRestart(stateDir)?.id === id) unlinkSync(path(stateDir));
};
