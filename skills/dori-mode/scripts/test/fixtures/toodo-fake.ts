// A Toodo server's lead inbox and chat kept in one JSON file, so it outlives a killed supervisor (and stands in for a
// Toodo restart: a new instance reads the same file). Only the chat tools Dori calls are modelled.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { ToodoApi, ToodoMessage, ToodoPending, ToodoPendingItem } from "../../src/messenger/toodo.ts";

export type FakeToodoState = {
  messages: (ToodoMessage & { taken?: boolean; acked?: boolean; handledBy?: string })[];
  events: { id: number; taskId: number; title: string; status: string; taken?: boolean }[];
  typing: boolean;
  calls: string[];
};

export const fakeToodoState = (path: string): FakeToodoState =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as FakeToodoState : { messages: [], events: [], typing: false, calls: [] };

export const fileToodo = (path: string, hooks: { beforeTake?: () => void } = {}): ToodoApi & { readonly state: () => FakeToodoState } => {
  const load = (): FakeToodoState => fakeToodoState(path);
  const save = (s: FakeToodoState): void => writeFileSync(path, JSON.stringify(s));
  const change = <T>(name: string, edit: (s: FakeToodoState) => T): T => {
    const s = load();
    s.calls.push(name);
    const out = edit(s);
    save(s);
    return out;
  };
  const items = (s: FakeToodoState): ToodoPendingItem[] => [
    ...s.messages.filter((m) => m.author === "user" && !m.taken && !m.origin).map((m) => ({ id: `chat-${m.id}`, at: m.at, kind: "chat", body: m.body })),
    ...s.events.filter((e) => !e.taken).map((e) => ({ id: `event-${e.id}`, at: 0, kind: "task_event", taskId: e.taskId, title: e.title, status: e.status })),
  ];
  const page = (s: FakeToodoState): ToodoPending => {
    const all = items(s);
    return { items: all.slice(0, 50), ...(all.length > 50 ? { remaining: all.length - 50 } : {}) };
  };
  return {
    state: load,
    peek: async () => change("peek", page),
    take: async (ids) => {
      hooks.beforeTake?.();
      return change(`take ${ids.join(",")}`, (s) => {
        for (const m of s.messages) if (ids.includes(`chat-${m.id}`)) m.taken = true;
        for (const e of s.events) if (ids.includes(`event-${e.id}`)) e.taken = true;
        return { items: [] };
      });
    },
    ack: async (ids) => change(`ack ${ids.join(",")}`, (s) => { for (const m of s.messages) if (ids.includes(`chat-${m.id}`)) m.acked = true; }),
    reply: async (text, handles = []) => change(`reply ${handles.join(",")}`, (s) => {
      const message: ToodoMessage = { id: (s.messages.at(-1)?.id ?? 0) + 1, author: "lead", body: text, at: 0 };
      s.messages.push(message);
      for (const m of s.messages) if (handles.includes(`chat-${m.id}`)) m.handledBy = `reply ${message.id}`;
      s.typing = false;
      return message;
    }),
    markHandled: async (id, link) => change(`handled ${id}`, (s) => {
      const m = s.messages.find((x) => `chat-${x.id}` === id);
      if (m) m.handledBy = "replyId" in link ? `reply ${link.replyId}` : `task ${link.taskId}`;
    }),
    typing: async (on) => change(`typing ${on}`, (s) => { s.typing = on; }),
    listChat: async (after, limit = 100) => change("list", (s) => {
      const rest = s.messages.filter((m) => m.id > after);
      return { messages: rest.slice(0, limit), more: rest.length > limit };
    }),
  };
};
