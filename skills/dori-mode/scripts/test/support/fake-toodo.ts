import { ToodoClient, type ToodoFetch } from "../../src/toodo-client.ts";

/**
 * A toodo-server `/api/rpc` stand-in for lane reads: workspace 1 holds the lane task #10 (depends on #11, related to
 * #20 in workspace 2) and #11, #12; workspace 9 holds #30, linked to nothing. Every request path is recorded, and any
 * command that is not a read answers 400, so a test sees whether a write was ever attempted.
 */
export const TASKS = [
  { id: 10, workspaceId: 1, title: "Lane task alpha", description: "the lane's own work", status: "in_progress", resolution: null, dependsOn: [11], refs: ["lane:ap-10-1"] },
  { id: 11, workspaceId: 1, title: "Prerequisite", description: "done before", status: "done", resolution: "merged", dependsOn: [], refs: [] },
  { id: 12, workspaceId: 1, title: "Sibling alpha", description: "same workspace", status: "planned", resolution: null, dependsOn: [30], refs: [] },
  { id: 20, workspaceId: 2, title: "Related elsewhere", description: "linked by relation", status: "planned", resolution: null, dependsOn: [], refs: [] },
  { id: 30, workspaceId: 9, title: "Private alpha", description: "personal workspace", status: "planned", resolution: null, dependsOn: [], refs: [] },
];
export const RELATIONS = [{ taskId: 10, relatedId: 20 }];
export const GUIDELINES: Record<number, unknown[]> = { 1: [{ id: 1, workspaceId: 1, kind: "rule", body: "Reply in Korean", createdAt: 1, updatedAt: 1 }], 9: [{ id: 2, workspaceId: 9, kind: "memory", body: "private", createdAt: 1, updatedAt: 1 }] };
const READS = new Set(["get_task", "list_tasks", "list_task_relations", "list_guidelines"]);

/** `tokenFile` must hold a non-empty token: ToodoClient reads it before every request. */
export const fakeToodo = (tokenFile: string) => {
  const paths: string[] = [];
  const fetch: ToodoFetch = async (url, init) => {
    const path = new URL(url).pathname;
    paths.push(path);
    const command = path.replace("/api/rpc/", "");
    const args = JSON.parse(String(init.body)) as Record<string, unknown>;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (!READS.has(command)) return json({ error: "not a read" }, 400);
    if (command === "get_task") { const t = TASKS.find((x) => x.id === args.id); return t ? json(t) : json({ error: "taskNotFound" }, 404); }
    if (command === "list_task_relations") return json(RELATIONS);
    if (command === "list_guidelines") return json(GUIDELINES[args.workspaceId as number] ?? []);
    const filter = (args.filter ?? {}) as { workspaceId?: number; ids?: number[]; before?: number; limit?: number };
    return json(TASKS.filter((t) => (filter.workspaceId === undefined || t.workspaceId === filter.workspaceId)
      && (filter.ids === undefined || filter.ids.includes(t.id)) && (filter.before === undefined || t.id < filter.before)).sort((a, b) => b.id - a.id));
  };
  const client = () => new ToodoClient({ url: "http://127.0.0.1:47616", tokenFile }, { fetch });
  return { paths, client, fetch };
};
