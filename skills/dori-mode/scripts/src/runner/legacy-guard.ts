import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export const LEGACY_GUARD_AGENT_FILES = ["guard-agent.sh", "guard-agent.ps1", "guard-agent.version"] as const;

export const legacyGuardAgentFiles = (home: string): string[] =>
  LEGACY_GUARD_AGENT_FILES.map((file) => join(home, ".dori", file)).filter(existsSync);

export const removeLegacyGuardAgent = (home: string): string[] => {
  const files = legacyGuardAgentFiles(home);
  for (const file of files) rmSync(file, { force: true });
  return files.map((file) => file.slice(join(home, ".dori").length + 1));
};
