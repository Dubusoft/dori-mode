# Messaging a session

This is the one home of the pre-send check. Other docs point here instead of repeating it.

Never send to a shell, a stopped agent or an approval prompt. Before you type into a pane:

1. check it runs a live agent (`herdr pane process-info --pane <id>`), not a shell, a stopped agent or a startup screen;
2. read it (`herdr pane read <id> --source recent-unwrapped --lines 40`) and confirm the input line is empty and no approval or question prompt is open;
3. send once, as one argument;
4. confirm delivery from a state change: the pane's `agent_status` moving to working, or the message showing up in the session record. Short of that, read the input line back: only when your own text is still sitting there unsubmitted, press Enter once more; still there after that, the send failed. If the line is empty but no change shows up, treat the send as unconfirmed.

The scripts' pane sends (`sendVerified`, `sendGuarded`, the queued lane messages: CI, rebase, done-claim notice, objection) do all of this: they type nothing into an input line that holds other text or shows no prompt and retry on a later pass, and our own text left there unsubmitted only gets Enter, never a second copy.

Exit code 0 and echoed input aren't proof the agent got the message. A reply from the session, or its record of handling the message, is.

## Owner decisions

The supervisor never talks to the owner itself, with two exceptions:

- a lane question with choices becomes a `[결정]` thread, and a lane's owner-input request (`dori report <key> request`) a `[요청]` thread, in the decisions channel (#inbox to the owner; wired by `decisionsChannel` id), opened by the supervisor;
- every day at 09:00 `displayTimeZone`, while any decision or request still waits, the supervisor posts one `[System]` reminder listing them in the decisions channel.

The owner's answer is not forwarded to the lane. The lead relays it.

| What you close | How |
|---|---|
| decision obligation (an event that needs your call) | `dori resolved <eventId>` |
| owner decision (a thread waiting on the owner) | `dori decision close <id> --text "..." [--choice N]` |
