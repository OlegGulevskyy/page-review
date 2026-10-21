# page-review

Readable guide: [README.html](README.html).

Google-Docs-style comment threads on any local HTML page or dev server, answered by a coding
agent. Select text and press **Comment** (or Alt+click an element); the server starts `claude`
(or `codex`) in the project the page lives in, and it replies in the thread and edits the page.
The next comment in the same thread resumes the same agent session.

```
browser page ──(injected client.js)──► review server :4848 ──► <dir>/.page-review.json (+ ~/.page-review/db.json)
                                          │  ▲
                        on comment: spawn  │  │HTTP (MCP server review_* tools, or the CLI)
                                          ▼  │
                  claude -p / codex exec, cwd = project_root  (or a webhook, e.g. a T3 Code task)
```

- **Plain files**: each directory gets its own port, files are served with the client injected,
  and the page reloads itself when the file changes (scroll, open panel and drafts survive).
  Threads are stored next to the files in `<directory>/.page-review.json`: delete it to clean
  the review up. The directory's `project_root` (nearest `.git`, `package.json`, `CLAUDE.md`,
  `AGENTS.md`, `pyproject.toml`…) is passed to the agent as the context for the page.
- **Dev servers** (Next.js, Vite, …): proxied on their own port with the client injected into
  HTML; websockets pass through, so HMR keeps working.
- **Anchors**: quoted text with prefix/suffix + CSS path + nearest heading, re-found after edits
  (CSS Custom Highlight API, so the page DOM is never modified). Threads whose text is gone show as
  "detached" but keep their history.
- **Runner**: 2.5 s after the user writes, the server runs `claude -p` (default) or `codex exec`
  headless in `project_root`, permissions bypassed (`--permissions accept-edits` to restrict),
  one run per thread at a time, 3 in parallel, 20 min timeout. The session id is kept on the
  thread and the next comment resumes it. Output goes to `~/.page-review/runs/<thread>.log`
  (`page-review log <id>`); a run that ends without replying leaves a note in the thread.
- **Webhook** (runner `webhook`): instead of a local run, POST
  `{event, site_id, thread_id, page_url, file, project_root, quote, text, …}` to the site's, the
  project's or the default webhook, e.g. a T3 Code webhook task that launches a thread per run.
  (T3 saves a *worktree* workspace strategy on such tasks; `page-review t3-task-root <taskId>`
  sets it to root, or runs fail at workspace preparation in a non-git project.)

## Use

```bash
page-review open ./report.html            # prints the review URL and opens it
page-review open http://localhost:3000/ --project ~/dev/app   # review a dev server
page-review runner codex                  # or claude (default), webhook, none
page-review log <thread_id>               # the last agent run on that thread
page-review list                          # ● = waiting for the agent
page-review get <thread_id>
page-review reply <thread_id> "Done"      # user resolves the thread in the browser
page-review webhook <site_id> <url>       # per-site override
page-review webhook --default <url>       # used by every site without its own
page-review status | stop
```

Agents use the MCP server instead (`review_open`, `review_list`, `review_get`, `review_reply`,
`review_set_status`, `review_set_webhook`, `review_sites`):

```bash
claude mcp add -s user page-review -- node ~/Documents/dev/page-review/src/mcp.js
```

and the `page-review` skill (`~/.claude-work/skills/page-review/SKILL.md`) for the workflow.

`PAGE_REVIEW_PORT` (default 4848; sites use 4850+), `PAGE_REVIEW_HOME` (default `~/.page-review`,
config, sites and dev-server threads),
`PAGE_REVIEW_AGENT_NAME` (default `Claude`). Everything listens on 127.0.0.1 only.
