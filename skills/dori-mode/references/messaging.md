# Messaging a session

This is the one home of the pre-send check. Other docs point here instead of repeating it.

To message a lane, local or remote, use `dori lane send <key> --text "..."` instead of typing into its pane: it runs the check below through the lane's runner, refuses while the lane shows a question prompt, and prints one line (`LANE_SEND_DELIVERED`, `LANE_SEND_UNCONFIRMED`, or `LANE_SEND_REFUSED`/`LANE_SEND_FAILED` with nothing typed and nothing retried). The steps below are for a pane that is not a lane.

Never send to a shell, a stopped agent or an approval prompt. Before you type into a pane:

1. check it runs a live agent (the runner's process read of the pane), not a shell, a stopped agent or a startup screen;
2. read it (`hc read <id> --lines 40`) and confirm the input line is empty and no approval or question prompt is open;
3. send once, as one argument;
4. confirm delivery from a state change: the pane's `agent_status` moving to working, or the message showing up in the session record. Short of that, read the input line back: only when your own text is still sitting there unsubmitted, press Enter once more; still there after that, the send failed. If the line is empty but no change shows up, treat the send as unconfirmed.

The scripts' pane sends (`sendVerified`, `sendGuarded`, the queued lane messages: CI, rebase, done-claim notice, objection, `dori lane send`) do all of this: they type nothing into an input line that holds other text or shows no prompt and retry on a later pass, and our own text left there unsubmitted only gets Enter, never a second copy.

Exit code 0 and echoed input aren't proof the agent got the message. A reply from the session, or its record of handling the message, is.

## Owner decisions

The supervisor never talks to the owner itself, with one exception: a lane question with choices becomes a `[결정]` thread, and a lane's owner-input request (`dori report <key> request`) a `[요청]` thread, in the decisions channel (#inbox to the owner; wired by `decisionsChannel` id), opened by the supervisor. A lane's `--nonblocking` request is not posted: it reaches the lead as a digest `LANE_REQUEST_NONBLOCKING` line. A question for a lane or task that already has an open blocking decision (one the lead opened included) is posted into that decision's thread instead of a new one (`attachedTo`), and a shared thread is archived only when its last decision closes. Its starter message says the thread holds another matter and asks for the answer as a Discord reply to it. With several decisions waiting in one thread (a shared thread, or a lane's own thread holding more than one question), an owner message answers the one whose question message it replies to, else the only one its text names by id (`d136`); one that names none answers none and reaches the lead only as `INBOUND`, who closes the decision it answers with `--from`. A message one decision already holds as an answer, or covered with its close, never becomes another decision's answer (`owner-decisions.ts` answerTarget). A lane's secret request is never posted: the lead grants it ([secrets](secrets.md)). No reminder of waiting decisions is posted to the decisions channel; the lead sees them in `dori inbox take` (`decision:` lines, and `UNRESOLVED` once answered).

The supervisor forwards no owner answer to a lane by itself, except for one kind of answer: Decision answers straight to the lane (below). Every other answer reaches the lead, and the lead's `dori decision close` on a lane's own question or request (asked with `dori report`), or on a decision the lead opened with `--relay-to <lane>`, types its `--text` into that lane, local or remote (`decision-relay.ts`), while the owner's thread gets only the outcome and `레인 <key>에 전달합니다` (or `--owner-text`), never the lane's text; it prints `DECISION_RELAYED`, `DECISION_RELAY_SKIPPED` (the answer already reached the lane directly, or the lane is closed) or `DECISION_RELAY_RETRYING` (not typed yet: the supervisor tries again under the same lane message, never typing it twice, and raises urgent `DECISION_RELAY_FAILED` once only after the last attempt fails; then the lead hands the answer over itself). A decision the lead opened without `--relay-to` is relayed by the lead.

| What you close | How |
|---|---|
| decision obligation (an event that needs your call) | `dori resolved <eventId>` |
| owner decision (a thread waiting on the owner) | `dori decision close <id> --text "..." [--owner-text "..."] [--choice N] [--tasks N]`, the first call on the answer: it also acks the answer messages, posts the reply and records them handled |

## Decision answers straight to the lane

Status: built. The supervisor records a lane decision's target when it opens, stores answer revisions with their delivery intent (`owner-decisions.ts`), and routes each owner message to one side as below, edits and deletes included (`decision-inbound.ts`): a direct answer is queued for the lane and the lead gets `DECISION_ANSWER_DIRECT` (digest) or `DECISION_ANSWER_CORRECTED` (urgent) instead of `INBOUND`. The delivery round checks the target again right before typing (`ci-follow.ts`), and every supervisor round (`decisionDeliveryTick`) reconciles intents with the queue, keeps the owner's status message current, closes a decision on its lane's ack (`DECISION_ANSWER_ACKED`, digest), and hands an answer whose lane session went away to the lead once (`DECISION_ANSWER_UNDELIVERED`). This section is what the routing has to do, and the one place it is defined.

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

### Answer buttons

A question with options (a lane's, or one the lead opened with `dori decision open`; never a `[요청]` request) is posted with one button per option under its starter message (`messenger/decision-buttons.ts`): label `N. <option>` cut to 80 characters, the recommended option in the primary style, up to 5 per row (2 rows for 6-9 options). The custom_id `dori:decide:<dID>:<N>` names the decision and the option, so a button answers exactly one question even in a shared thread. The starter message ends with "버튼을 누르거나, 이 스레드에 번호나 문장으로 답해 주세요." ("이 메시지에 답장(reply)해서" in place of "이 스레드에" for one in a shared or lane thread)

The supervisor's gateway handles a click (`discord-commands.ts`, `decision-inbound.ts` routeDecisionClick). A click by anyone but the owner (or from another application or guild) gets an ephemeral refusal. The owner's click is acknowledged at once, routed, then its buttons are updated to the decision's state and an ephemeral reply only the owner sees follows (except for a first direct answer, last case below):

- a click from any channel other than the decision's own thread, or on an unknown decision, is refused;
- a click on a closed decision says it is closed; one after the lane acked the answer says the lane already has it and records nothing;
- a click on the option the buttons already show changes nothing;
- a click on a decision that cannot take a direct answer (the lead opened it, or a check in "What is delegated" fails: the lane relaunched or closed, the lead already holds an answer) goes to the lead: it is recorded as an answer the lead holds (`click:<interaction id>` with its choice, once per interaction), the buttons show it, and the owner is told it went to the lead. The first answer raises the urgent obligation `OWNER_DECISION_ANSWERED <lane> d<ID> ... choice=N "<option>" via button; run dori decision close d<ID> --choice N --text "..." first ...`; a different button before the close raises urgent `DECISION_ANSWER_CORRECTED <lane> d<ID> choice=M "<option>" replaces choice=N via button: ...`. The lead settles it with `dori decision close d<ID> --choice N`: that resolves the obligation, disables the buttons with the choice marked, relays the choice and `--text` to a lane's question (decision-relay.ts, also when an older direct answer with another choice already reached the lane), and acks or records handled only real messages (a click is none);
- otherwise the click is the answer `d<ID>=<N>` typed in the decision's thread: an answer revision of owner "message" `click:<interaction id>` (a redelivered click is the same revision), queued and reported to the lead exactly like a typed direct answer. A first answer gets no reply of its own: the decision's `[System]` notice in the thread (Owner-facing notices below) is its one visible confirmation, also for a click made while the supervisor restarted. A click on the choice the newest revision already holds changes nothing; a different button before the lane acks is a correction, a new revision like an edited answer.

The buttons show the decision's state (`decision-buttons.ts` decisionButtonState): the newest answer's option is green and marked `✓` (none after a withdrawal); all of them are disabled once that answer is acked or undelivered, or the decision closes (the closed decision's `--choice` stays marked). A click updates them in its own reply; the supervisor's delivery round (`decisionDeliveryTick`) and `dori decision close` (before the archive) edit the starter message when it shows anything else, recording what it shows as the decision's `buttons`. A close that cannot edit them prints `DECISION_BUTTONS_NOTE`.

The lead's lines for a direct answer name the option text and the button: `DECISION_ANSWER_DIRECT ap-1-1 d1 r1 choice=2 "Replace" decision-d1-r1 from <thread>/click:<id> via button: ...` (also `DECISION_ANSWER_CORRECTED` and `DECISION_ANSWER_ACKED`).

A click made while the supervisor restarted reaches the next process when it resumes the gateway session, past Discord's answer window, so its acknowledgement fails. It is still routed like any click: the buttons are edited with the bot's token and the reply is posted in the thread as `[System] 재시작 중에 누른 버튼(d<ID> N번)입니다. ...`; one the lane cannot take directly goes to the lead as above.

A free-text answer is unchanged: it goes to the lead whole, and the lead's `dori decision close --text` relays it.

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

A lane on a worker machine is told to ack with the runner's own CLI, `~/.dori/runner/bin/dori report ack ...`, since only that one is installed there. The lane checks that the revision is the newest it has for that decision and that the choice is within its brief, then runs the ack command. The ack means the lane received the answer, not that the work is done. On the ack the supervisor closes the decision as `dori decision close` would (choice recorded, answer messages acked and recorded handled, confirmation posted, link line in the origin thread updated, thread archived), and every step can be replayed after a crash. A lane that receives a newer revision follows it and acks it; an older one it already acked is superseded.

### Owner-facing notices

The supervisor keeps one `[System]` status message per direct answer in the decision's thread and edits it in place as the answer moves. The text is in the owner's language; in Korean:

| State | Notice |
|---|---|
| recorded, being delivered | `d17: 2번으로 기록했습니다. 레인 <key>에 전달하는 중입니다.` |
| waiting (pane busy, lane paused, runner offline) | `d17: 2번으로 기록했습니다. 레인 <key>이 받을 수 있게 되면 전달합니다.` |
| typed into the lane, not acked yet | `d17: 2번을 레인 <key>에 전달했습니다. 레인의 수신 확인을 기다립니다.` |
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
- **Pane busy**: the message waits in the queue. The runner never clears an input line, presses Escape or types over other text; it only presses Enter on its own unsubmitted text. The runner serializes its own sends, but the gap between reading the screen and typing is not atomic, so text typed into the pane in that gap can still collide. Strict isolation needs an atomic input condition in hc or a direct session channel.
- **Lane paused**: the message waits; delivery never resumes a paused lane.
- **Runner offline or unreachable**: a send that surely did not happen waits for the reconnect. A send whose result was lost is retried under the same id, never as a new message, so the lane sees one copy.
- **No ack**: an unconfirmed message reaches the lead after `ciConfirmMin` as `LANE_MESSAGE_UNCONFIRMED`, once, like any other lane message; until then the owner's notice says it waits.
- **Supervisor crash**: at start, intent, queue, ack and close are reconciled; an answer stays "waiting" to the owner until the ack is in. An intent with no queued message is queued under its fixed id; one whose queued message is lost, or whose lane session is gone, is marked undelivered and the lead gets `DECISION_ANSWER_UNDELIVERED <lane> d<ID> r<n> ...` once.

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
