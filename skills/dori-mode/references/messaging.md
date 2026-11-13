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

The owner's answer is not forwarded to the lane. The lead relays it. Decision answers straight to the lane (below) narrows this for one kind of answer; until the supervisor ships it, every answer still goes through the lead.

| What you close | How |
|---|---|
| decision obligation (an event that needs your call) | `dori resolved <eventId>` |
| owner decision (a thread waiting on the owner) | `dori decision close <id> --text "..." [--choice N] [--tasks N]`, the first call on the answer: it also acks the answer messages, posts the reply and records them handled |

## Decision answers straight to the lane

Status: contract only. The supervisor does not route answers this way yet; until it does, the lead relays every answer as above. This section is what that routing has to do, and the one place it is defined.

The idea: when a lane asked the owner a question with choices and the owner answers with nothing but a choice, the answer goes to the lane through the lane message queue and the lead is not woken for it. Anything else goes to the lead, whole.

### What is delegated

An answer goes straight to the lane only when all of these hold, checked when the message comes in and again right before the runner types it:

- the decision was opened by that lane's own `dori report <key> question` (`source: "lane"`). A decision the lead opened with `dori decision open`, `--lane` or not, always goes to the lead; no flag delegates one. A `[요청]` request (a code, a value or a file) always goes to the lead;
- the decision is open: not closed, not cancelled;
- the lane it names is still registered and not closed, on the same runner and the same session generation it had when it asked. A lane relaunched, replaced or moved to another machine since then is a different target;
- the answer has the exact form below and picks one option in range.

What the lane gets is the owner's choice for that question and nothing more. It acts on the choice within its brief; a choice that would change its scope, its Done line or another lane's work is still raised with `dori report <key> question` or `blocked`, not assumed.

### Answer form

Only two forms qualify. The whole message, after trimming whitespace, must be one of them:

- `N`, the option number in ASCII digits, posted in a thread where this is the only open question: its own `[결정]` thread, or the lane's thread when it holds just this one open question. In a thread with several open questions, a bare `N` qualifies only as a Discord reply to that question's message;
- `d<ID>=<N>` (for example `d17=2`, `d` case-insensitive, no spaces), anywhere the supervisor reads the owner: the decision's thread, a shared thread or a watched channel.

`N` must be between 1 and the number of options. No model, keyword match or "newest question" guess decides a target: if the form does not name exactly one open decision, the answer is not direct.

### Everything else goes to the lead, whole

The supervisor never splits a message. When any of these holds, the full message reaches the lead exactly as it does today (`INBOUND`, then `OWNER_DECISION_ANSWERED`), and the lead closes the decision with `dori decision close`:

- any other text around the number (a reason, a condition, "2, but also ..."), even a short one;
- an attachment, a link, or a mention of another lane, thread, task or repo;
- more than one answer in one message (`d17=2 d18=1`);
- a number out of range, a decision id that is unknown, closed or not the lane's, or a target that is not exactly one open question;
- a request thread, or a decision the lead opened;
- a lane that fails the target check above.

### Routed once

Each owner message is classified before anything is queued for the lead, and lands on exactly one side: direct or lead, never both. A direct answer sends no `INBOUND` and no `OWNER_DECISION_ANSWERED` to the lead and opens no decision obligation; the lead sees it only in its digest (below). Changing the class of `OWNER_DECISION_ANSWERED` alone is not enough, because `INBOUND` for the same message is enqueued first.

Each direct answer is stored as an answer revision: decision id, owner message id, edit revision, content hash, choice and target (lane key, runner, session generation). The revision number `r<n>` starts at 1 and grows with each edit or new answer to the same decision.

### Delivery and the lane's ack

Under the decision's lock the supervisor records the delivery intent, then queues one lane message with the fixed id `decision-d<ID>-r<n>` (for example `decision-d17-r1`). The two writes are not one transaction: a crash between them is repaired at the next start by comparing intent, queue, ack and close, never by sending again. The message goes through the same guarded delivery as the other lane messages (pre-send check above). Its text names the decision, the question, the chosen number and option text, the revision, and the ack command:

```
[dori] Owner answered d17 (<question>): 2. <option text>. Revision r1. Confirm with: dori report ack decision-d17-r1
```

The lane checks that the revision is the newest it has for that decision and that the choice is within its brief, then runs `dori report ack decision-d17-r1`. The ack means the lane received the answer, not that the work is done. On the ack the supervisor closes the decision as `dori decision close` would (choice recorded, answer messages acked and recorded handled, confirmation posted, link line in the origin thread updated, thread archived), and every step can be replayed after a crash. A lane that receives a newer revision follows it and acks it; an older one it already acked is superseded.

### Owner-facing notices

The supervisor keeps one `[System]` status message per direct answer in the decision's thread and edits it in place as the answer moves. The text is in the owner's language; in Korean:

| State | Notice |
|---|---|
| recorded, being delivered | `d17: 2번으로 기록했습니다. 레인 <key>에 전달하는 중입니다.` |
| waiting (pane busy, lane paused, runner offline) | `d17: 2번으로 기록했습니다. 레인 <key>이 받을 수 있게 되면 전달합니다.` |
| lane acked | `d17: 레인 <key>이 2번을 받았습니다.` (then the decision closes) |
| revised before delivery | `d17: 3번으로 바꿔 기록했습니다. 레인 <key>에 전달하는 중입니다.` |
| revised or withdrawn after delivery | `d17: 레인 <key>에 정정(3번)을 보냈습니다.` / `d17: 답을 취소했다고 레인 <key>에 알렸습니다.` |
| not delivered | `d17: 레인 <key>이 종료되거나 바뀌어 전달하지 못했습니다. 리드가 이어받습니다.` |

An answer that goes to the lead gets no notice from the supervisor: the lead's `dori decision close` posts the reply as today.

### Revisions

- An edit or a second qualifying answer to the same decision before delivery replaces the queued message: the old id is marked superseded and `decision-d<ID>-r<n+1>` is queued. The lead gets a digest line.
- After the message may have reached the lane (sent, unconfirmed or acked), the supervisor queues a correction `decision-d<ID>-r<n+1>` that says which revision it replaces, and wakes the lead once.
- An edit that leaves the qualifying form, or a delete, withdraws the answer: before delivery the queued message is cancelled and the decision is open again (digest); after it, the lane gets a withdrawal message under the next revision id and the lead is woken once. The withdrawn text itself goes to the lead like any other answer.
- The same revision seen twice (gateway and REST catch-up) is ignored.
- A later owner message in the thread that does not qualify (a follow-up, a scope change) goes to the lead; if a direct answer is still in flight, the lead is woken once with both.

### Failures

- **Lane closed, replaced or moved**: the undelivered message is superseded, never redirected to another session; the owner gets the "not delivered" notice and the lead is woken once to take the answer over with `dori decision close`.
- **Pane busy**: the message waits in the queue. The runner never clears an input line, presses Escape or types over other text; it only presses Enter on its own unsubmitted text. The runner serializes its own sends, but the gap between reading the screen and typing is not atomic, so text typed into the pane in that gap can still collide. Strict isolation needs an atomic input condition in herdr or a direct session channel.
- **Lane paused**: the message waits; delivery never resumes a paused lane.
- **Runner offline or unreachable**: a send that surely did not happen waits for the reconnect. A send whose result was lost is retried under the same id, never as a new message, so the lane sees one copy.
- **No ack**: an unconfirmed message reaches the lead after `ciConfirmMin` as `LANE_MESSAGE_UNCONFIRMED`, once, like any other lane message; until then the owner's notice says it waits.
- **Supervisor crash**: at start, intent, queue, ack and close are reconciled; an answer stays "waiting" to the owner until the ack is in.

### What the lead sees

| Outcome | Lead |
|---|---|
| direct answer recorded, delivered and acked | digest line naming the decision, lane, choice and message id; no `INBOUND` |
| the same revision again | nothing |
| waiting on a busy pane, a paused lane or a short runner outage | nothing while it waits; the digest shows how long. Woken once past the deadline or when the outcome is unclear |
| target no longer matches (lane closed or replaced) | woken once |
| mixed answer, new work, lead decision, request, free text | woken, as today |
| edit or delete before delivery | digest |
| edit or delete after delivery | woken once |
| more than one possible target | woken, as today |
| thread post failed, queue damaged, delivery unconfirmed | woken once when it needs action; a failure a retry clears is digest |
