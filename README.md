# page-review

Review local HTML pages and running development servers with Claude Code or Codex. Select text, leave a comment, and let your coding agent answer or make changes. Threads stay open until you resolve them.

```sh
npm install -g page-review
page-review setup
page-review demo
page-review open ./report.html
```

Requires Node.js 20.12 or newer. Automatic replies also require a separately installed, signed-in Claude Code or Codex CLI. Provider account and usage charges are separate.

The interactive setup lets you select Claude, Codex, both, or neither, installs the selected skills, and registers agent tools. Skills are strongly recommended, but optional. The package includes the CLI, local server, MCP server, skills, sample page, and HTML guide.

```sh
page-review help
page-review help open
page-review status --open
page-review guide
```

Read the full **[HTML getting-started guide](README.html)** (also available with `page-review guide`) for setup, commands, troubleshooting, data locations, and uninstall instructions. Maintainers: see **[the HTML publishing guide](PUBLISHING.html)**.

MIT license. Review links run on your own computer; this is not a hosted collaboration service.
