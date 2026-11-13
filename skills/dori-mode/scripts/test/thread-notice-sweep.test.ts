import { expect, test } from "bun:test";
import { type ChannelMessage, sweepThreadNotices, type SweepTransport } from "../src/thread-notice-sweep.ts";

const fake = (messages: readonly ChannelMessage[], parents: Record<string, string>) => {
  const deleted: string[] = [];
  const transport: SweepTransport = {
    // Like Discord: newest first, at most 100 per page, only ids below `before`.
    messagesBefore: async (_channel, before) =>
      [...messages].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).filter((m) => before === undefined || BigInt(m.id) < BigInt(before)).slice(0, 100),
    threadState: async (threadId) => {
      if (!(threadId in parents)) throw new Error("404 Unknown Channel");
      return { parent: parents[threadId] };
    },
    deleteMessage: async (_channel, id) => { deleted.push(id); },
  };
  return { transport, deleted };
};

const channel = "555";
// Plain messages around the notices, past one page so the sweep must page back.
const plain = Array.from({ length: 150 }, (_, i) => ({ id: String(2000 + i), type: 0 }));
const messages: ChannelMessage[] = [
  ...plain,
  { id: "1000", type: 18, reference: "1000" },
  { id: "1001", type: 18, reference: "1001" },
  { id: "1002", type: 18, reference: "9999" },
  { id: "1003", type: 18 },
  { id: "1004", type: 18, reference: "1004" },
  { id: "1005", type: 0, reference: "1000" },
];
const parents = { "1000": channel, "1001": channel, "9999": "777" };

test("a dry run lists the channel's own thread notices and deletes nothing", async () => {
  const { transport, deleted } = fake(messages, parents);
  const result = await sweepThreadNotices(transport, channel, false);
  expect(result.notices.map((n) => n.id).sort()).toEqual(["1000", "1001"]);
  expect(result.skipped.map((s) => s.id).sort()).toEqual(["1002", "1003", "1004"]);
  expect(result.deleted).toEqual([]);
  expect(deleted).toEqual([]);
});

test("--apply deletes only type 18 notices whose thread sits in the channel", async () => {
  const { transport, deleted } = fake(messages, parents);
  const result = await sweepThreadNotices(transport, channel, true);
  expect(deleted.sort()).toEqual(["1000", "1001"]);
  expect([...result.deleted].sort()).toEqual(["1000", "1001"]);
});
