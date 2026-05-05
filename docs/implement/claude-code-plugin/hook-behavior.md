# Claude Code Plugin Hook Behavior

**Status:** Current implementation summary
**Scope:** `packages/claude-code-plugin`

This document describes what the Rundown Claude Code plugin hooks do today, and which pieces are essential for the runbook workflow versus optional compatibility surface.

## Overview

The plugin uses a single dispatcher for all configured Claude Code hook events. The hook entrypoint is intentionally broad, but most behavior falls into a few core functions:

- context injection from `.claude/context/` and plugin `context/`
- synthetic lifecycle events for slash commands and skills
- runbook auto-start from command/skill frontmatter
- delegation token detection and completion handling
- optional config-driven gates
- best-effort session state tracking

The hook manifest wires many Claude events to the same CLI entrypoint, but only a subset are essential to Rundown itself.

## Core Workflow

The runbook workflow itself is narrower than the full hook surface.

For the current implementation, the core runtime pieces are:

- `PreToolUse` for delegation dispatch
- `SubagentStop` for delegated child completion and agent-scoped context injection

Everything else is support code around that core:

- `SlashCommandStart` / `SkillStart` bootstrapping
- synthetic lifecycle bridging
- session tracking
- optional config gates
- compatibility hooks for additional Claude events

If the goal is to make the runtime more Codex-compatible, the right simplification is to keep the delegation core and treat the rest as optional host adapters rather than required behavior.

## Hook Matrix

| Hook | Current behavior | Essential? | Notes |
|------|------------------|------------|-------|
| `SessionStart` | Runs context injection and optional config gates through the shared dispatcher. | No | Compatibility surface; useful for startup context, not core workflow. |
| `SessionEnd` | Runs the same dispatcher path as other general lifecycle events. | No | Primarily compatibility / future-proofing. |
| `UserPromptSubmit` | If the prompt starts with `/`, the dispatcher synthesizes `SlashCommandStart`. Also resets `active_command` before synthetic processing. | Yes | Important for slash-command lifecycle and command-scoped context. |
| `Stop` | Synthesizes `SlashCommandEnd` when a slash command is active. | Yes | Needed to close command lifecycle cleanly. |
| `SlashCommandStart` | `on-command-start` reads command frontmatter and auto-runs the referenced runbook. | Yes | One of the main entry points into runbooks. |
| `SlashCommandEnd` | Injected synthetically from `Stop` when a command is active. | Yes | Not a direct hook behavior, but part of the command lifecycle. |
| `SkillStart` | `on-skill-start` reads skill frontmatter and auto-runs the referenced runbook. | Yes | Second main entry point into runbooks. |
| `SkillEnd` | Injected synthetically from `PostToolUse` when the `Skill` tool finishes. | Yes | Closes the skill lifecycle used by runbook startup. |
| `PreToolUse` | For `Skill`, synthesizes `SkillStart`. For `Agent`/`Task`, detects delegation tokens and injects claim instructions. | Yes | Critical for delegation orchestration. |
| `PostToolUse` | For `Skill`, synthesizes `SkillEnd`. For file edits, records edited files and extensions in session state. | Yes | Needed for skill lifecycle and lightweight session tracking. |
| `PostToolUseFailure` | Runs through the dispatcher for context and optional gates. | No | Present for completeness; no unique Rundown workflow branch. |
| `SubagentStart` | Uses agent-type-aware context discovery. | Yes | Important for agent-scoped context injection. |
| `SubagentStop` | Uses agent-command-aware context discovery and handles delegated child runbook completion / cleanup. | Yes | Required for delegated child completion. |
| `Notification` | Runs through the dispatcher for context and optional gates. | No | Compatibility surface. |
| `PreCompact` | Runs through the dispatcher for context and optional gates. | No | Compatibility surface. |
| `PermissionRequest` | Runs through the dispatcher for context and optional gates. | No | Compatibility surface. |
| `ConfigChange` | Runs through the dispatcher for context and optional gates. | No | Compatibility surface. |
| `WorktreeCreate` | Runs through the dispatcher for context and optional gates. | No | Compatibility surface. |
| `WorktreeRemove` | Runs through the dispatcher for context and optional gates. | No | Compatibility surface. |
| `TaskCompleted` | Runs through the dispatcher for context and optional gates. | No | Compatibility surface. |
| `TeammateIdle` | Runs through the dispatcher for context and optional gates. | No | Compatibility surface. |

## What The Dispatcher Does

The shared dispatcher follows this order:

1. Log the incoming hook event.
2. Update session state best-effort.
3. Inject context from naming-convention files.
4. Add workflow context when a runbook is active.
5. Derive synthetic `SlashCommandStart` / `SlashCommandEnd` / `SkillStart` / `SkillEnd` events.
6. Load `rundown-plugin.json` if present.
7. Apply hook filters and configured gates.
8. Return context, or block / stop when a gate requires it.

That makes the dispatcher the real core of the plugin. The individual hook files mostly route specific events into that shared pipeline.

## Essential Pieces

If the goal is “keep Rundown working with the current Claude workflow,” these are the required behaviors:

- `SlashCommandStart` handling, because it starts runbooks from slash-command frontmatter.
- `SkillStart` handling, because it starts runbooks from skill frontmatter.
- `PreToolUse` delegation detection, because it injects claim instructions for child agents.
- `SubagentStop` handling, because it resolves delegated child completion and command-scoped context.
- `UserPromptSubmit` and `Stop`, because they connect the synthetic command lifecycle.
- `PostToolUse`, because it closes synthetic skill lifecycle and records edited files.
- The shared dispatcher and context injection pipeline, because they are the common execution path for everything above.

If the goal is “simplify for Codex compatibility,” the essential runtime narrows further:

- `PreToolUse` delegation dispatch
- `SubagentStop` delegated child completion and agent-scoped context injection

## Optional Pieces

These hook events are currently useful, but not required for the delegation core:

- `SessionStart`
- `SessionEnd`
- `PostToolUseFailure`
- `Notification`
- `PreCompact`
- `PermissionRequest`
- `ConfigChange`
- `WorktreeCreate`
- `WorktreeRemove`
- `TaskCompleted`
- `TeammateIdle`

## Practical Takeaway

Most of the plugin is not separate per-hook logic. It is one dispatcher with a few important branches:

- command startup
- skill startup
- delegation dispatch
- subagent completion
- synthetic lifecycle bridging

If you are planning a Codex port or a host-agnostic abstraction, preserve the delegation branches first and treat the rest as compatibility layers that can be reintroduced selectively.
