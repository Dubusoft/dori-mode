// One toodo source pass that SIGKILLs itself right before take_pending: the items are peeked and journaled, never taken.
// argv: <stateDir> <toodoFile>
import { supervisorToodo } from "../../src/messenger/toodo-supervisor.ts";
import { Supervisor } from "../../src/supervise.ts";
import { depsFor, fakeClock, newWorld } from "../fakes.ts";
import { fileToodo } from "./toodo-fake.ts";

const [stateDir = "", toodoFile = ""] = process.argv.slice(2);
const clock = fakeClock(1_800_000_000_000);
const supervisor = new Supervisor(depsFor(newWorld(), clock, stateDir));
const toodo = fileToodo(toodoFile, { beforeTake: () => { process.kill(process.pid, "SIGKILL"); } });
const inbound = supervisorToodo({ toodo: () => toodo, enqueue: (id, line) => supervisor.enqueue(id, line), stateDir, now: clock.now, pollMs: 60_000 });
await inbound.pass();
console.log("NOT_KILLED");
