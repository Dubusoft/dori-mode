# Messaging a session

This is the one home of the pre-send check. Other docs point here instead of repeating it.

Never send to a shell, a stopped agent or an approval prompt. Before you type into a pane:

1. check it runs a live agent (`herdr pane process-info --pane <id>`), not a shell, a stopped agent or a startup screen;
2. read it (`herdr pane read <id> --source recent-unwrapped --lines 40`) and confirm the input line is empty and no approval or question prompt is open;
3. send once, as one argument (the scripts' `sendVerified` does this);
4. confirm delivery from a state change: the pane's `agent_status` moving to working, or the message showing up in the session record. Never press Enter again because of what the screen shows; if no change shows up, treat the send as unconfirmed.

Exit code 0 and echoed input aren't proof the agent got the message. A reply from the session, or its record of handling the message, is.
