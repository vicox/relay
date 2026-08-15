# Operating

One practical arrangement for coordinating coding agents with Relay. It is not part of the
product model and not the way to use Relay — it is an arrangement that was worked through
and is written down so it need not be re-derived. Relay knows nothing about any of it:
there is no ticket, no worktree and no role in the API, and nothing here changes what
[product-model.md](product-model.md) says is absent.

Read it as a worked example. Where a choice was forced by something Relay actually does,
that reason is given; the rest is convention and can be replaced wholesale.

## The shape

A coordinator — ChatGPT over MCP — drives one Claude and one Codex per unit of work, and
those two can also talk to each other directly. Each unit of work gets its own directory,
so two agents can run at once without fighting over one checkout.

```
<workspace>/
  repos/<project>        a clone, and the hub worktrees are made from
  worktrees/<ticket>     one worktree per ticket
  AGENTS.md              conventions the agents read
  CLAUDE.md -> AGENTS.md
```

`repos/<project>` is an ordinary clone. It is where `git worktree add` is run from and
where fetched refs land; no work happens in it. A bare clone works too, but needs its
fetch refspec set by hand — `git clone --bare` configures none, so `git fetch` updates
`FETCH_HEAD` and nothing else, and `origin/*` never appears.

`worktrees/<ticket>` is one worktree per ticket, named for the ticket. Directory name,
branch name and ticket key are the same string, which is what makes a session's `cwd`
enough to identify what it is working on.

A flat `worktrees/` across projects only works if ticket keys are unique across them —
true for Jira-style keys like `BLCK-520`, not true for branch names like `fix-auth`.
Group by project underneath if they are not.

## Two kinds of session

**The Ops session** has the workspace root as its `cwd`. It creates and removes worktrees
and does nothing else. It is long-lived: one per workspace, not one per ticket.

It exists because a session's `cwd` is fixed when the session is allocated and there is no
operation that changes it (`start` in [api.md](api.md#start)). An agent that must create
`worktrees/<ticket>` needs the root as its `cwd`, and it then keeps that `cwd` for the rest
of its life — so it cannot go on to be the agent that works inside the new worktree. The
two jobs need two sessions.

**Ticket sessions** have a ticket worktree as their `cwd`. A Claude and a Codex share the
same worktree: the reviewer reads exactly the files the implementer writes, with no copy
and no second checkout. That only holds as long as one of them writes — a reviewer that
commits or switches branches breaks the arrangement, which is why it is stated in
`AGENTS.md` rather than left to be inferred.

## The lifecycle

1. **Ops creates the worktree.** From `repos/<project>`:
   `git worktree add -b <ticket> ../../worktrees/<ticket>`, or with a start point when the
   work continues someone else's branch. Wait for the turn to reach `idle` before the next
   step.
2. **Start the ticket sessions.** `start("claude", "<workspace>/worktrees/<ticket>")` and
   `start("codex", "<workspace>/worktrees/<ticket>")`. Neither spawns a process; nothing
   runs until the first `send`.
3. **Brief the implementer.** The task, plus the reviewer's address. The address must be in
   the message text — see *Addressing* below.
4. **Claude implements. Codex reviews.** Whether that is plan-then-code, code-then-review,
   or several rounds is the agents' business. Relay carries the messages and records the
   turns.
5. **The coordinator watches.** `status` and `read` from the cursor `send` returned. Relay
   pushes nothing, so this is polling; `read` will wait up to 30 s per call.
6. **After the merge**, `forget` both sessions, then have Ops run
   `git worktree remove ../../worktrees/<ticket>` and delete the branch. `forget` refuses
   while a turn is in flight, so a session that is still busy has to finish or be
   interrupted first.

## One turn in flight, and what follows from it

Relay's one rule — a session runs one turn at a time, and a `send` to a busy session fails
with `busy` rather than queueing ([product-model.md](product-model.md#the-one-rule-that-makes-this-work))
— has a consequence that only shows up once two agents talk to each other.

`relay ask` sends and then reads until the recipient is idle. It blocks. And a blocked
`ask` is running inside the asking agent's own turn, so **the asker's session is busy for
the whole exchange**.

So when A asks B:

- B answers within its turn. Its reply reaches A as the result of A's `ask`.
- B must not also `send` to A. A is busy — busy waiting for B — and the send fails.
- The coordinator's `send` to A fails too, for the same reason. A long-busy session usually
  means it is waiting on the other agent, not that it is stuck.

Stated for the agents: **whoever asks holds the thread.** The one who was asked answers and
stops there.

`send` on its own does not block, so an agent that wants to hand work over and carry on can
use it — but then the reply arrives as a fresh turn later, and nothing correlates it with
what prompted it. `ask` is the simpler shape when a reply is actually needed.

## Addressing

Relay does not tell a recipient who wrote to it. `from` is provenance for the transport
log; the agent never sees it ([api.md](api.md#transport-metadata)). An agent that should be
able to reply has to be told the address in the message text, and an agent that wants a
reply has to write its own address into what it sends.

This is worth stating twice in the instructions, because the failure is silent: the
recipient simply has nobody to answer.

## Recovery

A coordinator that has lost its bookkeeping does not need any. `list` returns every session
with its `cwd`, and the `cwd` ends in the ticket key — so the mapping from ticket to
sessions is always reconstructible from Relay itself.

This matters more than it looks: a chat-based coordinator starts each conversation with no
memory of the last one.

The CLI's `relay list` prints agent, session, state and native id, but not `cwd`; `relay
status` prints the whole record. Over MCP, `list` returns the full object.

## Instructions for the agents

Claude Code reads `CLAUDE.md`, walking up from its working directory and concatenating
every file it finds, root-most first. A file at the workspace root therefore reaches every
ticket session, and a `CLAUDE.md` committed in the project is read after it — general
conventions first, project specifics last. Codex reads `AGENTS.md`; a symlink lets one file
serve both.

Keep per-ticket facts out of it. The reviewer's session address changes every ticket and
belongs in the message that starts the work, not in a file that is loaded into every turn.

### Workspace `AGENTS.md`

```markdown
# Relay workspace

You are running as a session under Relay. Another agent can write to you, and you can
write to it. Relay only delivers messages — it does not plan, schedule or retry.

## Layout

    repos/<project>      clone, and the hub worktrees are created from — not a place to work
    worktrees/<ticket>   one worktree per ticket, e.g. blck-520

Directory name = branch name = ticket number.

## Your role follows from your working directory

**Your cwd is a worktree** — you are working on that one ticket.

- Do not switch branches, and do not create or remove worktrees.
- Do not change anything outside your own worktree. If you are reviewing, you read.

**Your cwd is the workspace root** — you are the Ops session.

- You create and remove worktrees. That is all.
- You do not implement and you do not review.

## Talking to the other agent

- If you are meant to reach another agent, its address is in the message that gave you
  your task. Relay does not tell a recipient who wrote to it, so if you want a reply, put
  your own address in the text you send.
- `relay ask <agent> <session> "..."` sends and waits for the answer.
- One turn runs per session. A `send` to a busy agent fails with `busy` and is not
  queued and not retried.
- **Whoever asks holds the thread.** While you are waiting inside `relay ask`, your own
  session is busy. So if someone asked you, answer within your turn — do not also send
  them a message of your own, because it will fail while they are waiting on you.
```

### ChatGPT project instructions

Relay has nowhere to put these. The MCP tool descriptions tell a caller what the seven
operations do, but not how this workspace is arranged. A ChatGPT project's custom
instructions are the place; they apply to every chat in the project, which suits one chat
per ticket.

```
You coordinate Claude and Codex through Relay.

## Fixed setup

Ops session:
claude/<OPS_SESSION_ID>
cwd: <WORKSPACE>

The Ops session is long-lived. It creates and removes worktrees only.

Workspace:

    <WORKSPACE>/repos/<project>
    <WORKSPACE>/worktrees/<ticket>

## Per ticket

1. Ask Ops to create the worktree:

   cd <WORKSPACE>/repos/<project> &&
   git worktree add -b <ticket> ../../worktrees/<ticket>

   Wait until the Ops turn is idle.

2. Start both ticket sessions in the same worktree:

   start("claude", "<WORKSPACE>/worktrees/<ticket>")
   start("codex",  "<WORKSPACE>/worktrees/<ticket>")

   Claude is the implementer.
   Codex is the reviewer.

3. Brief Claude with the task and include the Codex session address when Claude should
   be able to ask Codex directly.

4. Monitor with status and read. Let Claude and Codex communicate directly through Relay
   where useful. Intervene when a decision is needed, they are stuck, or the work is done.

5. After merge:
   - forget both ticket sessions;
   - ask Ops to remove the worktree.

## Relay rules

- One turn may be in flight per session.
- Sending to a busy session fails and is not queued.
- Use the cursor returned by send when reading.
- read may wait up to 30000 ms.
- A turn is complete only when state is "idle".
- Relay does not push updates; poll with status/read.
- Before interrupting a long-running busy session, check whether it is waiting on the other agent.

## Recovery

If context is lost, call list.

Each session includes its cwd, and the worktree path contains the ticket key, so the
ticket-to-session mapping can be reconstructed.
```

## What this arrangement does not do

No retry, no scheduling, no escalation when a review stalls, no record that a ticket
exists at all. The coordinator holds all of that, or nobody does. That is the same
division Relay draws everywhere else: the agents plan, and Relay carries the messages.
