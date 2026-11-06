import { Database } from "bun:sqlite";
import { join } from "node:path";
import { HUB_FILE, RunnerHub } from "../src/runner/hub.ts";

/** Saves `label`'s herdr state on its hub row in `stateDir` (creating the table and the row), as the supervisor's inference does. */
export const markHerdr = (stateDir: string, label: string, state: "up" | "down" | "hung", since: number): void => {
  new RunnerHub({ stateDir, commit: () => true, now: () => since, monotonic: () => 0, epoch: 1 }).close();
  const db = new Database(join(stateDir, HUB_FILE));
  try {
    db.query("INSERT OR IGNORE INTO runners (label) VALUES (?)").run(label);
    db.query("UPDATE runners SET herdr = ?, herdrSince = ? WHERE label = ?").run(state, since, label);
  } finally { db.close(); }
};
