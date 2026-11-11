# session-projects

A **Projects** pane for Claude Code that groups all your sessions by project, with the folder each project lives in shown after its name.

## What it does

- Lists your sessions (cloud and Remote Control) in groups, newest activity first.
- Finds each session's folder from the commands it ran (for example `D:\projects\birdwatch` becomes `birdwatch`). Sessions in the same folder are grouped automatically.
- A group can be given a project name (**Name** / **Rename** on its header). The folder name stays visible after it in smaller text.
- Sessions with no folder go to **Unsorted**. Use **Move** on a row to file one.
- Shows status per session: working, needs you, done, and unread.
- **Filter sessions…** searches titles, project names and folder names. **Needs me** shows only sessions waiting on you. **Hide archived** hides archived sessions.
- Each title links to the session on claude.ai.

Project names are stored as `project:<name>` tags on the sessions themselves, so they are kept on the server and not lost when a container goes away.

Each session's folder is stored the same way, as a `folder:<path>` tag (`folder:none` for an archived session with no folder). A fresh machine reads those tags instead of reading every session again, so the groups are right as soon as the session list arrives. On a machine that has shown the pane before, the last list it saw is shown at once and updated in place.

## Commands

- `/projects` opens the pane and refreshes it.
- `/file-under <name>` files the current session under a project. Without a name it opens the picker.

## Requirements

It reads your session list through the `claude-code-remote` tools that cloud sessions have. In a session without them the pane says so.

## Install

At the prompt of a terminal session:

```
/plugin install session-projects --marketplace m-hallmann/claude-session-projects
```

From a shell:

```
claude plugin install session-projects --marketplace m-hallmann/claude-session-projects
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `m-hallmann/claude-session-projects`, then **Add plugin**.

To have it in every cloud session, add this to the cloud environment's setup script:

```
if command -v claude >/dev/null 2>&1; then
  claude plugin install session-projects --marketplace m-hallmann/claude-session-projects --scope user </dev/null || echo "session-projects: install failed, continuing"
fi
```
