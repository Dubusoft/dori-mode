import { parentPort, workerData } from "node:worker_threads";
import { claimSlot } from "../../src/launch-admission.ts";
import type { MachineCheck } from "../../src/placement.ts";

const { stateDir, check, key, now, barrier } = workerData as {
  stateDir: string; check: MachineCheck; key: string; now: number; barrier: SharedArrayBuffer;
};
const gate = new Int32Array(barrier);
parentPort!.postMessage("ready");
Atomics.wait(gate, 0, 0);
parentPort!.postMessage(claimSlot(stateDir, check, key, "author", now));
