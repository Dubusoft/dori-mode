import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ack, AckError, EYES_EMOJI, handled, pendingAcks, recordHandled } from "../src/ack.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { withState, writeJournal } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const state = (): string => {
  const s = withState();
  cleanups.push(s.done);
  return s.dir;
};

const reactions = (fail: { unreact?: Error; react?: Error } = {}) => {
  const ops: string[] = [];
  return {
    ops,
    react: async (channel: string, message: string, emoji: string) => { ops.push(`add ${channel}/${message} ${emoji}`); if (fail.react) throw fail.react; },
    unreact: async (channel: string, message: string, emoji: string) => { ops.push(`remove ${channel}/${message} ${emoji}`); if (fail.unreact) throw fail.unreact; },
    typing: async (channel: string) => { ops.push(`typing ${channel}`); },
  };
};

test("dori ack removes the hourglass, adds the eyes back to back, then records the ack", async () => {
  const dir = state();
  const r = reactions();
  await ack(dir, r, "11", "22", 1_000);
  expect(r.ops).toEqual(["remove 11/22 \u23F3", `add 11/22 ${EYES_EMOJI}`, "typing 11"]);
  expect(pendingAcks(dir).map((a) => a.id)).toEqual(["discord:11:22"]);
});

test("dori ack sends typing after the eyes reaction and records the receipt", async () => {
  const dir = state();
  const r = reactions();
  const typing = r.typing;
  r.typing = async (channel: string) => {
    expect(r.ops).toEqual(["remove 11/22 \u23F3", `add 11/22 ${EYES_EMOJI}`]);
    expect(pendingAcks(dir).map((a) => a.id)).toEqual(["discord:11:22"]);
    await typing(channel);
  };
  await ack(dir, r, "11", "22", 1_000);
  expect(r.ops).toEqual(["remove 11/22 \u23F3", `add 11/22 ${EYES_EMOJI}`, "typing 11"]);
});

test("typing rejection does not prevent or undo the recorded ack", async () => {
  const dir = state();
  const r = reactions();
  r.typing = async (channel: string) => {
    r.ops.push(`typing ${channel}`);
    throw new Error("indicator unavailable");
  };
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    await expect(ack(dir, r, "11", "22", 1_000)).resolves.toBeUndefined();
  } finally {
    console.error = originalError;
  }
  expect(pendingAcks(dir).map((a) => a.id)).toEqual(["discord:11:22"]);
  expect(errors).toEqual(["ACK_TYPING_FAILED 11 22: indicator unavailable"]);
});

test("a message without an hourglass (404) is still acked; any other removal failure is not", async () => {
  const dir = state();
  await ack(dir, reactions({ unreact: new MessengerError("discord DELETE: 404 Unknown Reaction", 404) }), "11", "22", 1_000);
  expect(pendingAcks(dir).map((a) => a.id)).toEqual(["discord:11:22"]);
  const other = state();
  const r = reactions({ unreact: new MessengerError("discord DELETE: 403 Missing Access", 403) });
  await expect(ack(other, r, "11", "23", 1_000)).rejects.toThrow("403");
  expect(r.ops).toEqual(["remove 11/23 \u23F3"]);
  expect(pendingAcks(other)).toEqual([]);
});

test("no eyes on the message means no ack: a failed reaction leaves it for the supervisor to remind", async () => {
  const dir = state();
  await expect(ack(dir, reactions({ react: new MessengerError("discord PUT: 500", 500) }), "11", "22", 1_000)).rejects.toThrow("500");
  expect(pendingAcks(dir)).toEqual([]);
});

test("ids must be Discord snowflakes", async () => {
  const dir = state();
  const r = reactions();
  await expect(ack(dir, r, "11", "../22", 1_000)).rejects.toBeInstanceOf(AckError);
  expect(r.ops).toEqual([]);
});

test("ack declares separate tasks without claiming any are handled", async () => {
  // Given a message containing two independent tasks.
  const dir = state();
  // When the lead acknowledges it with a task count.
  await ack(dir, reactions(), "11", "22", 1_000, 2);
  // Then the durable receipt carries the count, without invented coverage.
  expect(pendingAcks(dir)[0]).toMatchObject({ id: "discord:11:22", tasks: 2 });
  expect(pendingAcks(dir)[0]?.lanes).toBeUndefined();
  expect(pendingAcks(dir)[0]?.reply).toBeUndefined();
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("invalid task count %s fails before changing reactions", async (tasks) => {
  // Given an invalid owner-task declaration.
  const dir = state();
  const r = reactions();
  // When the lead tries to acknowledge it.
  await expect(ack(dir, r, "11", "22", 1_000, tasks)).rejects.toBeInstanceOf(AckError);
  // Then neither the read receipt nor reactions change.
  expect(r.ops).toEqual([]);
  expect(pendingAcks(dir)).toEqual([]);
});

test("handled requires explicit lane or reply coverage and validates ids", () => {
  // Given no durable receipt.
  const dir = state();
  // When invalid completion declarations are submitted.
  expect(() => recordHandled(dir, "11", "22", 1_000, {})).toThrow(AckError);
  expect(() => recordHandled(dir, "../11", "22", 1_000, { reply: true })).toThrow(AckError);
  expect(() => recordHandled(dir, "11", "22", 1_000, { lanes: ["../alpha"] })).toThrow(AckError);
  // Then none falsely mark the message handled.
  expect(pendingAcks(dir)).toEqual([]);
});

test("receipts of a removed channel left in the acks directory are ignored, Discord ones still read", async () => {
  // Given an old toodo-* receipt next to a Discord ack.
  const dir = state();
  await ack(dir, reactions(), "11", "22", 1_000);
  writeFileSync(join(dir, "acks", "toodo-12-x.json"), JSON.stringify({ channel: "toodo", message: "12", at: 1_000 }));
  // Then only the Discord ack is pending, and the channel name is refused for new receipts.
  expect(pendingAcks(dir).map((a) => a.id)).toEqual(["discord:11:22"]);
  expect(() => recordHandled(dir, "toodo", "12", 1_000, { reply: true })).toThrow(AckError);
});

test("handled on a message never acked runs the ack first, then records the link marked auto-acked", async () => {
  // Given an owner message the lead never acked.
  const dir = state();
  const r = reactions();
  // When the lead marks it handled.
  const outcome = await handled(dir, () => r, "11", "22", 1_000, { reply: true });
  // Then it gets the same ack as dori ack, and the link says the ack was missing.
  expect(outcome).toEqual({ autoAck: "acked" });
  expect(r.ops).toEqual(["remove 11/22 \u23F3", `add 11/22 ${EYES_EMOJI}`, "typing 11"]);
  const receipts = pendingAcks(dir);
  expect(receipts.filter((receipt) => receipt.reply)).toMatchObject([{ id: "discord:11:22", autoAck: "acked" }]);
  expect(receipts.filter((receipt) => !receipt.reply)).toHaveLength(1);
});

test.each(["pending", "tracked"])("handled on a message already acked (%s) changes no reaction", async (where) => {
  // Given an ack the supervisor has not consumed yet, or one it already tracks.
  const dir = state();
  if (where === "pending") await ack(dir, reactions(), "11", "22", 1_000);
  else writeJournal(dir, { events: [], awaitingAck: [{ id: "discord:11:22", since: 500, ackedAt: 1_000 }] });
  // When the lead marks it handled.
  const outcome = await handled(dir, () => { throw new Error("no Discord call expected"); }, "11", "22", 2_000, { lanes: ["alpha"] });
  // Then only the link is recorded, with no auto-ack mark.
  expect(outcome).toEqual({});
  const link = pendingAcks(dir).find((receipt) => receipt.lanes);
  expect(link).toMatchObject({ id: "discord:11:22", lanes: ["alpha"] });
  expect(link?.autoAck).toBeUndefined();
});

test("a failed auto-ack still records the link, marked failed", async () => {
  // Given an unacked message whose eyes reaction fails.
  const dir = state();
  // When the lead parks it on the owner's answer.
  const outcome = await handled(dir, () => reactions({ react: new MessengerError("discord PUT: 500", 500) }), "11", "22", 1_000, { awaiting: true });
  // Then the warning carries the error, and only the link is recorded.
  expect(outcome).toEqual({ autoAck: "failed", error: "discord PUT: 500" });
  expect(pendingAcks(dir)).toMatchObject([{ id: "discord:11:22", awaiting: true, autoAck: "failed" }]);
});

test("invalid handled input fails before any reaction", async () => {
  const dir = state();
  const r = reactions();
  await expect(handled(dir, () => r, "11", "22", 1_000, {})).rejects.toBeInstanceOf(AckError);
  await expect(handled(dir, () => r, "../11", "22", 1_000, { reply: true })).rejects.toBeInstanceOf(AckError);
  expect(r.ops).toEqual([]);
  expect(pendingAcks(dir)).toEqual([]);
});

test("a link whose auto-ack failed does not count as an ack: the next handled tries again", async () => {
  const dir = state();
  await handled(dir, () => reactions({ react: new MessengerError("discord PUT: 500", 500) }), "11", "22", 1_000, { awaiting: true });
  const r = reactions();
  expect(await handled(dir, () => r, "11", "22", 2_000, { reply: true })).toEqual({ autoAck: "acked" });
  expect(r.ops).toEqual(["remove 11/22 \u23F3", `add 11/22 ${EYES_EMOJI}`, "typing 11"]);
});
