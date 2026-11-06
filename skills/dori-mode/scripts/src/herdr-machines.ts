import type { Ran, Runner } from "./run.ts";

/** herdr's saved machines as JSON (a host-level read, not lane access). */
export const herdrMachineList = (run: Runner): Promise<Ran> => run(["herdr", "machine", "list", "--json"]);
