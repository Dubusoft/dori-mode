/**
 * Generic owner-only button hooks. `dori send --buttons` posts buttons whose custom_id names a configured hook
 * (`dori:hook:<name>:<arg>` runs it on click, `dori:hookm:<name>:<arg>` first asks for text in a modal); the supervisor's
 * gateway answers the click and spawns `buttonHooks[<name>]`. The id carries everything, so no state is stored.
 */

/** A hook button's custom_id: kind, configured hook name, free argument. */
export const HOOK_BUTTON_ID = /^dori:(hook|hookm):([a-z0-9-]{1,20}):([A-Za-z0-9._:-]{1,70})$/;

const STYLES = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;

export type ButtonSpec = { readonly label: string; readonly id: string; readonly style?: keyof typeof STYLES };

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The one action row for `dori send --buttons JSON`: an array of 1-5 `{label, id, style?}` whose ids are hook button
 * ids. Throws an Error naming the first problem.
 */
export const buttonRow = (json: string): unknown[] => {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("--buttons must be a JSON array"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 5) throw new Error("--buttons must be a JSON array of 1 to 5 buttons");
  const seen = new Set<string>();
  const components = parsed.map((button: unknown, index) => {
    const at = `--buttons[${index}]`;
    if (!record(button)) throw new Error(`${at} must be an object with label and id`);
    const { label, id, style } = button;
    if (typeof label !== "string" || !label.trim() || label.length > 80) throw new Error(`${at}.label must be a non-empty string of at most 80 characters`);
    if (typeof id !== "string" || !HOOK_BUTTON_ID.test(id)) throw new Error(`${at}.id must match ${HOOK_BUTTON_ID.source}`);
    if (seen.has(id)) throw new Error(`${at}.id repeats an earlier button's id`);
    seen.add(id);
    if (style !== undefined && !(typeof style === "string" && Object.hasOwn(STYLES, style))) throw new Error(`${at}.style must be one of ${Object.keys(STYLES).join(", ")}`);
    return { type: 2, style: STYLES[(style ?? "secondary") as keyof typeof STYLES], label, custom_id: id };
  });
  return [{ type: 1, components }];
};

export type HookInteraction = {
  readonly id: string;
  readonly token: string;
  readonly application_id: string;
  readonly guild_id: string;
  readonly userId: string;
  /** Component click (3) or modal submit (5). */
  readonly type: 3 | 5;
  readonly customId: string;
  readonly kind: "hook" | "hookm";
  readonly name: string;
  readonly arg: string;
  /** The message's channel: the thread id when the message is in a thread. */
  readonly channel: string;
  readonly message?: { readonly id: string; readonly components: readonly unknown[] };
  /** The modal's "text" value; "" for a plain click. */
  readonly text: string;
};

/** The submitted value of the modal input whose custom_id is "text" (classic action rows or label components). */
const modalText = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = modalText(item);
      if (found !== undefined) return found;
    }
    return;
  }
  if (!record(value)) return;
  if (value.custom_id === "text" && typeof value.value === "string") return value.value;
  return modalText(value.components) ?? modalText(value.component);
};

/** A hook button click or its modal submit, else undefined. */
export const hookInteraction = (value: unknown): HookInteraction | undefined => {
  if (!record(value) || (value.type !== 3 && value.type !== 5) || !record(value.data) || typeof value.data.custom_id !== "string") return;
  if (value.type === 3 && value.data.component_type !== 2) return;
  const match = HOOK_BUTTON_ID.exec(value.data.custom_id);
  if (!match) return;
  if (typeof value.id !== "string" || typeof value.token !== "string" || typeof value.application_id !== "string" || typeof value.guild_id !== "string") return;
  if (typeof value.channel_id !== "string" || !record(value.member) || !record(value.member.user) || typeof value.member.user.id !== "string") return;
  const message = record(value.message) && typeof value.message.id === "string"
    ? { id: value.message.id, components: Array.isArray(value.message.components) ? value.message.components : [] }
    : undefined;
  const text = value.type === 5 ? modalText(value.data.components) ?? "" : "";
  return {
    id: value.id, token: value.token, application_id: value.application_id, guild_id: value.guild_id, userId: value.member.user.id,
    type: value.type, customId: value.data.custom_id, kind: match[1] as "hook" | "hookm", name: match[2]!, arg: match[3]!,
    channel: value.channel_id, ...(message ? { message } : {}), text,
  };
};

/** The label of the button with `customId` in a message's rows. */
export const buttonLabel = (rows: readonly unknown[], customId: string): string | undefined => {
  for (const row of rows) {
    if (!record(row) || !Array.isArray(row.components)) continue;
    for (const c of row.components) if (record(c) && c.custom_id === customId && typeof c.label === "string") return c.label;
  }
  return;
};

const RECEIVED = " - 접수됨";

/** The message's rows with every button disabled and the clicked one relabelled "<label> - 접수됨". */
export const disabledRows = (rows: readonly unknown[], customId: string): unknown[] =>
  rows.map((row) => !record(row) || !Array.isArray(row.components) ? row : {
    ...row,
    components: row.components.map((c: unknown) => !record(c) || c.type !== 2 ? c : {
      ...c, disabled: true, ...(c.custom_id === customId ? { label: `${(typeof c.label === "string" ? c.label : "").slice(0, 80 - RECEIVED.length)}${RECEIVED}` } : {}),
    }),
  });

/** The modal a `dori:hookm:` click opens: one required paragraph input "text". */
export const hookModal = (customId: string, label: string | undefined) => ({
  custom_id: customId,
  title: (label?.trim() || "내용").slice(0, 45),
  components: [{ type: 1, components: [{ type: 4, custom_id: "text", label: "내용", style: 2, required: true, max_length: 2000 }] }],
});

/** Starts a filled hook argv; must not throw. */
export type HookSpawner = (argv: readonly string[], name: string) => void;

const pipeLines = async (stream: ReadableStream<Uint8Array>, prefix: string): Promise<void> => {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) console.error(`${prefix} ${line}`);
  }
  pending += decoder.decode();
  if (pending) console.error(`${prefix} ${pending}`);
};

/** Default spawner: no shell, its own process group, output into the supervisor log as `BUTTON_HOOK <name> ...` lines. */
export const spawnButtonHook: HookSpawner = (argv, name) => {
  const prefix = `BUTTON_HOOK ${name}`;
  try {
    const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
    void Promise.all([pipeLines(child.stdout, prefix), pipeLines(child.stderr, prefix), child.exited])
      .then(([, , code]) => { console.error(`${prefix} exited ${code}`); }, () => { console.error(`${prefix} output read failed`); });
  } catch {
    console.error(`${prefix} spawn failed`);
  }
};
