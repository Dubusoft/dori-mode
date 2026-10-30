import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { leadModels, qualifiedModel, type DoriConfig, type LeadModel } from "./config.ts";

export class LeadRestartError extends Error {}

export type LeadRestartRequest = {
  readonly id: string;
  readonly at: number;
  readonly models: readonly LeadModel[];
};

const path = (stateDir: string): string => join(stateDir, "lead-restart.json");

export const pendingLeadRestart = (stateDir: string): LeadRestartRequest | undefined =>
  existsSync(path(stateDir)) ? JSON.parse(readFileSync(path(stateDir), "utf8")) : undefined;

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
