# Gravitas

> Gravitas is a derivative fork of the open-source AI desktop app **Proma** (github.com/ErlichLiu/Proma). Unless noted, the wording reflects this project.

Gravitas is a local-first AI desktop app that brings multi-model Chat, general-purpose Agent workflows, workspaces, Skills, MCP, remote bots, and memory into one open-source client.

It is not just another chat box. Gravitas is meant to become a long-lived Agent workbench for your personal workflows: use Chat for simple answers, use Agent when the task needs to act on files, tools, projects, and longer context.

![Proma Poster](https://img.erlich.fun/personal-blog/uPic/pb.png)

[中文 README](./README.md) | [Beginner Tutorial](./tutorial/tutorial.md) | [Open-Source Release](https://github.com/ErlichLiu/Proma/releases) | [Commercial Version](https://proma.cool/download)

## What Gravitas Can Do

- **Chat mode**: multi-model conversations, attachments, image input, Markdown / Mermaid / KaTeX / code highlighting, parallel conversations, system prompts, and context controls.
- **Agent mode**: general-purpose Agent with Pi, AI SDK, Claude, and Proma runtimes (default **Pi**, recommended **Pi** and **AI SDK**), workspace isolation or opening a local project directly, permission modes, file operations, long-running streaming output, plan confirmation, and ask-user interactions.
- **SubAgents / Tasks**: complex tasks can be delegated through the Claude Agent SDK Agent tool, with sub-agent calls and results shown in the message stream.
- **Workflow mode**: turn a recurring process into a reusable visual flow on a canvas (start / end, agent, tool, skill, transform, condition, and approval nodes), publish it, and run it manually, on a schedule, or on an event trigger. It supports node-level capability allowlists frozen at publish time, failure/retry and error routing, human approvals, and credential-free template distribution / upgrade / rollback. Once orchestrated, the flow runs on your terms without re-describing it each time.
- **Skills & MCP**: each workspace can manage its own Skills, MCP servers, and workspace files.
- **Work modules (Project Management / Schedule / Automation)**: the left work-module area provides enterprise project management and task tracking (projects / tasks / subtasks / kanban / meeting-note import with AI extraction / risk reports, with Feishu / DingTalk sync, one-click pull of meeting notes from DingTalk / Feishu / Lark cloud docs with AI task-draft extraction, and **AI Employees** — tasks assigned to an AI employee run unattended and write results back: safe-by-default permissions with per-task Bash/write/web requests, same-project concurrency queueing, 60s heartbeat, optional Workflow SOP binding as executor, and AI dimensions in project summary / risk report / team efficiency overview), a schedule manager (month calendar + task kanban + natural-language creation + conflict detection + multi-calendar-source sync, including macOS EventKit bridging and smart reminders), and an automation hub (schedules + run history + running-task center). Project management supports two modes — a **project-workspace mode** (bind an Agent workspace directly to a local project directory so the Agent reads and writes files rooted at that project) and a **task-tracking mode** (the projects / tasks / kanban system above). Both work modules and the settings panel use grouped navigation driven by a module registry to avoid entry sprawl.
- **Remote bots**: Lark / Feishu bot bridging is supported, with DingTalk and WeChat bridge entry points also present in the app.
- **Memory and tools**: Chat and Agent can share memory, with web search, built-in Chat tools, and Agent recommendation helpers.
- **Local-first data**: conversations, workspaces, attachments, settings, and Skills are stored under `~/.proma/` as JSON / JSONL files, without a local database.
- **Desktop experience**: auto-update, proxy settings, file preview, global shortcuts, quick task window, voice input, and light / dark / system themes.

## Getting Started

### Download

Download the open-source version from [GitHub Releases](https://github.com/ErlichLiu/Proma/releases). The current release notes are for `v0.9.12`, with builds for macOS Apple Silicon, macOS Intel, and Windows.

If you want fewer API setup steps, you can also use the [Proma commercial version](https://proma.cool/download). The commercial and open-source versions run in parallel; the commercial version mainly adds built-in model channels and subscription options.

### First Setup

1. Open Gravitas and finish the environment check. Agent mode depends on local tooling, especially Git, Node.js / Bun, and a usable shell.
2. Go to **Settings > Channels**, add at least one AI provider channel, and fill in Base URL, API Key, and model list.
3. Chat mode can use OpenAI, Anthropic, Google, or OpenAI-compatible channels.
4. Agent mode defaults to the **Pi runtime**, and we recommend using **Pi** and **AI SDK**. Pi works out of the box with many channel protocols (Anthropic, OpenAI-compatible, Google, and more); AI SDK also supports OpenAI-compatible as well as Anthropic and Google provider packages, and is the priority path for the upcoming server/Web direction. The Claude runtime requires an Anthropic or Anthropic-compatible channel; Proma remains usable as an earlier provider-agnostic runtime but is not the first choice.
5. Go to **Settings > Agent** and choose the default Agent channel, model, and workspace.
6. Configure memory, web search, or Feishu / DingTalk / WeChat bridges from their corresponding settings tabs if needed.

## Choosing A Mode

### Use Chat For

- Everyday Q&A, explanation, translation, rewriting, and lightweight code discussion.
- Reading attachments and summarizing or comparing their content.
- One-off conversations enhanced by web search or memory tools.
- Comparing outputs from multiple models or exploring different system prompts.

### Use Agent For

- Creating, editing, or organizing local files.
- Research, report writing, and multi-step tasks.
- Work that needs MCP, Skills, Shell, Git, project files, or external context.
- Tasks that benefit from permissions, plan mode, background execution, or remote bot follow-up.

### Use Workflow For

- Turning a recurring process into a reusable visual flow (agent, skill, MCP tool, condition, and approval nodes included) so future runs only need a trigger.
- Scheduled, event-driven, or human-approval-gated processes, such as digest roundups, scheduled report generation, or multi-step processing followed by manual confirmation.
- Flows you want to crystallize and reuse across workspaces with consistent execution (capability convergence and credential-free template distribution).

In short: **use Chat when you need an answer; use Agent when you need work to be done; use Workflow when you want to harden a process and run it repeatedly on your terms.**

## Screenshots

### Chat Analysis

Use Chat for lightweight but practical analysis: compare audience needs, generate a table, and shape first-screen README copy quickly.

![Gravitas Chat analysis](./docs/assets/screenshots/proma-chat-demo.png)

### Agent Workbench

Agent works inside a workspace, reads project files, progresses through tasks, outputs structured findings, and keeps reusable files visible in the right-side workspace panel.

![Gravitas Agent workbench](./docs/assets/screenshots/proma-agent-demo.png)

### Skills

Each workspace can keep its own reusable Skills. The `feedback-synthesis` Skill shown here turns scattered feedback, interviews, and issues into themes, evidence, and priority suggestions.

![Gravitas workspace Skills](./docs/assets/screenshots/proma-skills-demo.png)

### Skills & MCP

The same workspace can manage stdio and HTTP MCP servers, enabling or disabling external context per project.

![Gravitas MCP settings](./docs/assets/screenshots/proma-mcp-demo.png)

### Streaming Voice Input

Gravitas supports Doubao-powered streaming voice input, both inside Gravitas and across the desktop:

- Inside Gravitas: press Ctrl + Backtick to start recognition, then press it again to finish and insert the transcript into the active Gravitas input box.
- Outside Gravitas: press Ctrl + Backtick to start recognition, then press it again to finish and insert the transcript at the current cursor position. If there is no active cursor, Gravitas writes the transcript to the clipboard.

![Gravitas voice input](./docs/assets/screenshots/proma-typeless-input.png)

## Supported Providers

| Provider | Chat | Agent | Protocol |
| --- | --- | --- | --- |
| Anthropic | Supported | Supported | Anthropic Messages API |
| DeepSeek | Supported | Supported | Anthropic-compatible protocol |
| Kimi API | Supported | Supported | Anthropic-compatible protocol |
| Kimi Coding Plan | Supported | Supported | Anthropic-compatible protocol with dedicated auth headers |
| OpenAI | Supported | Not yet | Chat Completions |
| Google | Supported | Not yet | Gemini Generative Language API |
| Zhipu AI | Supported | Supported | Anthropic-compatible protocol |
| MiniMax | Supported | Supported | Anthropic-compatible protocol |
| Doubao | Supported | Supported | Anthropic-compatible protocol |
| Qwen | Supported | Supported | Anthropic-compatible protocol |
| Custom endpoint | Supported | Not yet | OpenAI-compatible protocol |

**We recommend using Pi and AI SDK.** Pi is the current default runtime and supports tools, MCP, Plan, AskUser, sub-agents, and partial streaming across many channel protocols, making it a good fit for most everyday personal tasks; AI SDK offers similar capabilities and is also the priority path for the upcoming server/Web direction. The Claude runtime still retains native SDK session / snapshot capabilities (fork / rewind closest to full timeline recovery); Proma remains usable as an earlier provider-agnostic runtime but is more limited and new tasks should prefer Pi or AI SDK. Chat mode uses Provider Adapters from `@proma/core` to support different protocols.

## Local Data

Gravitas stores data in local files so it is easy to back up, migrate, and inspect.

```text
~/.proma/
├── channels.json
├── conversations.json
├── conversations/
│   └── {conversation-id}.jsonl
├── agent-sessions.json
├── agent-sessions/
│   └── {session-id}.jsonl
├── agent-workspaces/
│   └── {workspace-slug}/
│       ├── workspace-files/
│       ├── mcp.json
│       └── skills/
├── attachments/
├── user-profile.json
├── settings.json
├── calendar/                    # schedule: events.jsonl / tasks.jsonl
├── projects/                    # project management: paa.db (sql.js SQLite)
└── sdk-config/
```

API keys are encrypted through Electron `safeStorage` before being written to `channels.json`. Core data is represented as JSON configuration and append-only JSONL logs; the project management module uses sql.js (in-memory SQLite persisted to `~/.proma/projects/paa.db`).

## Development

Gravitas is a Bun workspace monorepo.

```text
proma-v2/
├── packages/
│   ├── shared/     # shared types, IPC constants, config, utilities
│   ├── core/       # Provider Adapters, SSE, code highlighting
│   └── ui/         # shared React UI components
└── apps/
    └── electron/   # Electron desktop app
```

Current package versions:

| Package | Version | Responsibility |
| --- | --- | --- |
| `@proma/electron` | `0.9.12` | Electron desktop app |
| `@proma/shared` | `0.1.17` | shared types, IPC constants, config, utilities |
| `@proma/core` | `0.2.9` | Provider Adapters, SSE, Shiki highlighting |
| `@proma/ui` | `0.1.3` | shared React UI components |

Common commands:

```bash
# Install dependencies
bun install

# Development mode: Vite + Electron + hot reload
bun run dev

# Build Electron app
bun run electron:build

# Build and run
bun run electron:start

# Typecheck
bun run typecheck

# Test
bun test
```

More granular scripts are available inside the Electron app:

```bash
cd apps/electron

bun run dev:vite
bun run dev:electron
bun run build:main
bun run build:preload
bun run build:renderer
bun run dist:fast
```

## Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Bun |
| Desktop | Electron 39 |
| Frontend | React 18 + TypeScript |
| State | Jotai |
| Styling | Tailwind CSS + Radix UI |
| Rich text input | TipTap |
| Markdown / diagrams / math | React Markdown + Beautiful Mermaid + KaTeX |
| Code highlighting | Shiki |
| Build | Vite + esbuild |
| Distribution | electron-builder |
| Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.143` |

## Architecture

Gravitas's core communication path is:

```text
shared types and IPC constants
  -> main/ipc.ts handlers
  -> preload/index.ts window.electronAPI bridge
  -> renderer Jotai atoms and React components
```

Main-process services live in `apps/electron/src/main/lib/`:

- `agent-orchestrator.ts`: Agent orchestration, environment variables, SDK calls, event streams, error handling.
- `agent-session-manager.ts`: Agent session index and JSONL message persistence.
- `agent-workspace-manager.ts`: workspaces, MCP, Skills, and workspace files.
- `chat-service.ts`: Chat streaming, Provider Adapters, tool activity.
- `conversation-manager.ts`: Chat session index and message storage.
- `channel-manager.ts`: channel CRUD, API key encryption, connection tests, model fetching.
- `feishu-bridge.ts` / `dingtalk-bridge.ts` / `wechat-bridge.ts`: remote bot bridges.
- `memory-service.ts`, `chat-tool-*`, `document-parser.ts`, `workspace-watcher.ts`: memory, tools, document parsing, and file watching.

Renderer state is managed with Jotai. Key atoms live in `apps/electron/src/renderer/atoms/`. Agent IPC listeners are mounted globally at the app root so streaming events, permission requests, and background tasks survive view changes.

## Packaging Notes

`@anthropic-ai/claude-agent-sdk` uses platform native binaries since `0.2.113+`. Gravitas marks the SDK as external in esbuild and includes the SDK main package plus platform subpackages in `electron-builder.yml`.

When changing packaging configuration, make sure:

- Main-process esbuild keeps `--external:@anthropic-ai/claude-agent-sdk`.
- `apps/electron/package.json` includes target SDK platform subpackages in `optionalDependencies`.
- `apps/electron/electron-builder.yml` includes the SDK main package and platform subpackages in `files`.
- Ordinary npm dependencies should usually be bundled into `main.cjs` by esbuild instead of being marked external.

See [AGENTS.md](./AGENTS.md) for the full engineering conventions.

## Contributing

Bug fixes, documentation improvements, tests, UX polish, Skills, MCP configs, and real-world Agent workflows are all welcome.

Before opening a PR, please check:

- Use Bun scripts and do not mix npm / pnpm lockfiles.
- Use Jotai for state management.
- Keep the app local-first and prefer config files plus JSON / JSONL storage.
- Do not use TypeScript `any`; prefer `interface` for object shapes.
- When adding IPC, update shared types, main handler, preload bridge, and renderer calls together.
- Bump the patch version of affected packages when behavior changes.
- Add focused tests where possible, especially for shared logic, IPC contracts, and persistence formats.

Gravitas currently has a PR bounty program. You can leave your email in the PR description for follow-up.

![Proma PR Bounty](https://img.erlich.fun/personal-blog/uPic/PR%20%E8%B5%A0%E9%87%91%201.png)

## Star History

<a href="https://www.star-history.com/?repos=ErlichLiu%2FProma&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=ErlichLiu/Proma&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=ErlichLiu/Proma&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=ErlichLiu/Proma&type=date&legend=top-left" />
 </picture>
</a>

## Credits

- [Shiki](https://shiki.style/): code highlighting.
- [Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid): Mermaid diagram rendering.
- [Cherry Studio](https://github.com/CherryHQ/cherry-studio): inspiration for multi-provider desktop AI products.
- [Lobe Icons](https://github.com/lobehub/lobe-icons): AI / LLM brand icons.
- [Craft Agents OSS](https://github.com/lukilabs/craft-agents-oss): Agent SDK integration reference.
- [MemOS](https://memos.openmem.net): memory reference and integration.

## License

This project is licensed under the **Business Source License 1.1 (BSL-1.1)**. See the `LICENSE` file in the repository root.

- Before the **Change Date (2030-06-22)**, unless covered by an Additional Use Grant, the Licensed Work and its derivative works are restricted to non-production use (see the Additional Use Grant in `LICENSE`);
- Upon the **Change Date**, it automatically converts to the **Apache License, Version 2.0** (see `LICENSE-APACHE` in the repository root or https://www.apache.org/licenses/LICENSE-2.0).

For commercial / production licensing, please contact the Licensor.
