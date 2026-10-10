# Real T3 Connect acceptance test

This is intentionally manual: automated CI must never receive a real T3
credential. Use a non-critical T3 thread/project and keep another official T3
client open so cross-client state can be observed.

## Preflight

```bash
pnpm sync:t3
pnpm install
pnpm check
pnpm package
pnpm bundle:marketplace
dist/plugin/lib/t3-mini-bridge --self-test
pnpm deploy:plugin
```

Expected self-test output contains the current plugin version, protocol version
1, and the commit printed by `git -C upstream/t3code rev-parse HEAD`.

Confirm the widget is enabled:

```bash
omarchy plugin list --json | jq '.[] | select(.id == "bralyx.t3code")'
```

## Native T3 Connect sign-in and automatic return

1. Click the T3 mark in the Omarchy bar.
2. Click **Sign in with T3 Connect**.
3. Confirm the system browser opens a page on an ephemeral
   `http://127.0.0.1:<port>/` address offering Google and GitHub. Do not copy or
   paste a code.
4. Choose the real account provider and authenticate. T3 redirects through its
   packaged `t3code://app/` callback; the hidden plugin handler forwards that
   callback to the waiting loopback listener.
5. Confirm no full T3 Code window is opened for the callback and no callback
   value appears in the panel or logs.
6. Without clicking the bar again, confirm the Omarchy panel automatically
   opens at Inbox.
7. Confirm linked environment names load. Tokens must not appear in the panel,
   Quickshell logs, or stderr.
8. Confirm connection reaches `connected` rather than the legacy CLI
   OAuth/DPoP restriction. It must not display a pairing code.

## Full remote acceptance

Do not mark a release fully interoperable until all of the following pass:

1. Select an online T3 environment; connection reaches `connected` through
   relay authorization, environment DPoP exchange, WebSocket ticket, and
   authenticated Effect RPC.
2. Inbox renders pinned, active/working/input-needed, snoozed, and settled
   groups consistently with the official client.
3. Open an existing thread. Messages load without raw tool activity. Expand a
   changed-files card to inspect its directory tree, then start work in the
   official client and observe incremental assistant output here.
   Open a long thread and use **Load older messages**. Confirm older messages
   appear once, the visible message stays in place, and failures can be retried.
   Keep paging past the first window, then use **Jump to latest** and confirm
   live replies, approvals, and queued messages still match the official client.
4. Send a follow-up in the mini client and observe the user message plus
   streamed response in both clients.
5. Copy a screenshot, press **Ctrl+V** in the thread composer, confirm its
   removable preview appears, and send it with and without accompanying text.
   Confirm the image reaches the agent and its attachment appears in both
   clients.
6. Start a new task from a project/model in the mini client and confirm it
   appears in the official client.
7. While work is running, press **Stop** and confirm the turn is interrupted in
   both clients.
   Queue a follow-up before stopping. Confirm the queue shows as paused, edit
   its text without losing attachments, then resume it. Cancel another queued
   message and confirm both clients agree. Steering messages have a distinct
   label from messages that are still queued.
8. Trigger a command/file approval; approve or decline it here and confirm the
   provider resumes or rejects correctly.
9. Trigger a user-input question; answer it here and confirm the answer reaches
   the active agent.
10. Settle the thread here and confirm it moves to Settled in the official
   client. Unsettle it in the official client and confirm it returns here.
11. Repeat cross-client observation for snooze/wake and pin/unpin.
12. Close/restart the panel and shell. Confirm the credential survives through
    Secret Service, the preferred environment reconnects, and an open thread
    re-subscribes after a transport interruption.
13. Log out. Confirm the relay disconnects, the native Clerk Secret Service
    item is removed, and the panel returns to Login.

Record the T3 tag/SHA, environment server version, Omarchy version, and each
result. Never attach Secret Service output or callback query parameters to the
test record.
