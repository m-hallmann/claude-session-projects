# session-projects

A **Projects** pane for Claude Code that groups all your sessions by project, with the folder each project lives in shown after its name.

## What it does

- Lists your sessions (cloud and Remote Control) in groups, newest activity first.
- Finds each session's folder from the commands it ran (for example `D:\vibe-coding\port2port` becomes `port2port`). Sessions in the same folder are grouped automatically.
- A group can be given a project name (**Name** / **Rename** on its header). The folder name stays visible after it in smaller text.
- Sessions with no folder go to **Unsorted**. Use **Move** on a row to file one.
- Shows status per session: working, needs you, done, and unread.
- **Filter sessions…** searches titles, project names and folder names. **Needs me** shows only sessions waiting on you. **Hide archived** hides archived sessions.
- Each title links to the session on claude.ai.

Project names are stored as `project:<name>` tags on the sessions themselves, so they are kept on the server and not lost when a container goes away.

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

This repository is private: installing needs a machine that can read it on GitHub, with a git credential for github.com already set up (an SSH key, or `gh auth login` then `gh auth setup-git`).
