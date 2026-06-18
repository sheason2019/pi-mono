# d-pi Agent TS Migration Design

## Status

Draft

## Scope

This design defines a single workspace-schema upgrade for `packages/d-pi` that:

- replaces `agents/<name>/agent.json` with `agents/<name>/agent.ts` as the only runtime entrypoint
- moves session state from `.dpi-sessions/<agent>/` to `agents/<name>/session/`
- removes `d-pi export` / `d-pi import` from the design surface
- keeps `roles` as metadata only for this phase
- makes git the primary distribution path for agent definition and state

This design intentionally does **not** restore role-driven resource loading. That is deferred to a future phase.

## Goals

- Make `agent.ts` the only runtime definition format.
- Make agent definition, prompts, skills, and session state live under `agents/<name>/`.
- Provide a deterministic `d-pi migrate` path for existing workspaces.
- Keep session files as raw persisted files and allow them to be managed in git.
- Make migrated `agent.ts` files explicit and reviewable.

## Non-Goals

- No compatibility layer that continues to load `agent.json` at runtime.
- No `export` / `import` replacement in this phase.
- No role resource loading from `team-template/roles/<role>/...` in this phase.
- No new declarative session format.
- No automatic migration on `d-pi serve`.

## Schema Model

### Workspace Version

Introduce a new workspace schema version after the current `team-template` migration version.

Behavior:

- `d-pi serve` rejects workspaces below the new schema version.
- `d-pi migrate` upgrades the whole workspace to the new version.
- `d-pi init` creates the new version directly.

### Agent Layout

Each agent lives under:

```text
agents/<name>/
├── agent.ts
├── AGENTS.md
├── skills/
├── session/
└── .pi/
    └── APPEND_SYSTEM.md
```

The directory name `<name>` is the agent identity. `agent.ts` does not store `name`.

## agent.ts Design

### Entrypoint

`agents/<name>/agent.ts` default-exports `defineAgent(...)`.

Example shape:

```ts
import parentAgent from "../root/agent.ts";
import {
	defineAgent,
	defineContextFile,
	defineModel,
	defineSkill,
	defineTool,
} from "@sheason/d-pi";

const model = defineModel({
	provider: "anthropic",
	name: "claude-sonnet-4",
});

const skills = defineSkill({
	dir: "./skills",
});

export default defineAgent({
	parent: parentAgent,
	description: "Reviews code and reports risks.",
	roles: ["reviewer"],
	model,
	tools: [
		defineTool({ name: "dispatch_read" }),
		defineTool({ name: "dispatch_grep" }),
		defineTool({ name: "dispatch_bash" }),
		defineTool({ name: "send_message" }),
		defineTool({ name: "team" }),
	],
	skills,
	contextFiles: [
		defineContextFile({ type: "context", path: "./AGENTS.md" }),
		defineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),
	],
});
```

### defineAgent

`defineAgent(...)` keeps only:

- `parent`
- `description`
- `roles`
- `model`
- `tools`
- `skills`
- `contextFiles`

It does not store `name`.

### defineModel

`defineModel(...)` is the model declaration for a single agent.

Initial required fields:

- `provider`
- `name`

This phase does not require a full provider-secret modeling design inside `agent.ts`.

### defineTool

There is no `defineTools(...)`.

`tools` is an array of individual `defineTool(...)` objects:

```ts
tools: [defineTool(...), defineTool(...)]
```

The migrated result is always an explicit whitelist.

Old `includeTools` / `excludeTools` are not preserved as syntax. They are evaluated against the default tool table and emitted as the final explicit tool array.

### defineSkill

`defineSkill({ dir: "./skills" })` only scans the agent-local skills directory.

It does **not** load anything from `team-template/roles/...`.

### defineContextFile

Replace the vague `systemPrompts` idea with explicit `contextFiles`.

Supported types in this phase:

- `type: "context"` for `AGENTS.md`
- `type: "append_system"` for `APPEND_SYSTEM.md`

All paths emitted by migration are relative to `agent.ts`.

## Parent / Tree Semantics

`parent` is expressed by importing another agent definition:

```ts
import parentAgent from "../root/agent.ts";
```

and then:

```ts
parent: parentAgent
```

This builds tree topology only.

There is no inheritance of:

- model
- tools
- skills
- contextFiles

## Role Semantics

`roles` remain in `agent.ts`, but only as metadata.

In this phase:

- keep `roles` in migrated output
- do not load role skills
- do not load role prompts / context files
- do not load role extensions

This is an intentional temporary block, not an accidental omission.

## Context Loading Model

After this migration, runtime resource loading should be simplified to:

1. workspace-level fixed resources
2. agent-local resources declared by `agent.ts`
3. d-pi fixed runtime prompt
4. coding-agent base resources

Agent-local files are referenced, not rewritten:

- `./AGENTS.md`
- `./.pi/APPEND_SYSTEM.md`

If these files do not exist, the migrated `agent.ts` still contains explicit `defineContextFile(...)` entries so users can see the intended configuration surface.

## Session Persistence

Session files remain raw persisted files.

New location:

```text
agents/<name>/session/*.jsonl
```

No new declarative session format is introduced.

Runtime restores the latest session from the new directory.

`sessionId` is no longer part of the `agent.ts` config surface.

## Migration Design

### Command Contract

`d-pi migrate` upgrades the entire workspace in one operation.

`d-pi serve` does not auto-migrate. It fails fast and instructs the user to run `d-pi migrate`.

### Migration Inputs

- `.dpi/config.json`
- `agents/*/agent.json`
- `agents/*/AGENTS.md`
- `agents/*/.pi/APPEND_SYSTEM.md`
- `agents/*/skills/`
- `.dpi-sessions/<agent>/*.jsonl`

### Migration Outputs

- upgraded `.dpi/config.json`
- `agents/<name>/agent.ts`
- `agents/<name>/session/*.jsonl`
- existing `agents/<name>/AGENTS.md`
- existing `agents/<name>/.pi/APPEND_SYSTEM.md`
- existing `agents/<name>/skills/`

### Migration Order

1. Validate workspace version and old schema prerequisites.
2. Enumerate all `agents/*/agent.json`.
3. Build an in-memory agent graph from old `parentName` fields.
4. Generate standard-structure `agent.ts` files for every agent.
5. Move `.dpi-sessions/<agent>/` into `agents/<name>/session/`.
6. After all new files are in place, delete old `agent.json` files.
7. Delete old `.dpi-sessions/`.
8. Update `.dpi/config.json` to the new schema version.

### Deletion Policy

On successful migration:

- delete old `agent.json`
- delete old `.dpi-sessions/`

No backup directory is kept in this phase.

### Failure Policy

Migration should fail before destructive cleanup whenever possible.

Requirements:

- if any `agent.ts` generation fails, abort migration
- if any session move fails, abort migration
- destructive deletion only happens after all new targets are created successfully

## Old -> New Field Mapping

### agent.json

- `parentName` -> `import parentAgent from "../<parent>/agent.ts"` + `parent: parentAgent`
- `description` -> `description`
- `roles` -> `roles` metadata
- `model` -> `defineModel(...)`
- `includeTools` / `excludeTools` -> evaluated explicit `tools: [defineTool(...), ...]`
- `sessionId` -> dropped from config surface

### Agent-local Prompt Files

- `agents/<name>/AGENTS.md` -> `defineContextFile({ type: "context", path: "./AGENTS.md" })`
- `agents/<name>/.pi/APPEND_SYSTEM.md` -> `defineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" })`

### Skills

- `agents/<name>/skills/` -> `defineSkill({ dir: "./skills" })`

### Empty/Absent Resources

Even if an agent currently has no skills or agent-local prompt files, migration still emits the standard structure so users can see the configuration surface explicitly.

## Runtime Loading

After migration:

1. load workspace config
2. reject startup if workspace version is old
3. scan `agents/*/agent.ts`
4. dynamic-import each agent definition
5. derive agent name from directory name
6. build parent/child topology from `parent`
7. resolve model/tools/skills/contextFiles
8. restore session from `agents/<name>/session/`
9. start agent

No runtime path should read `agent.json`.

## CLI Behavior

### init

`d-pi init` should create the new schema directly.

### serve

When the workspace version is below target:

- fail startup
- print a direct instruction to run `d-pi migrate`

### migrate

Runs the whole schema upgrade described above.

## Testing

Required coverage:

1. migrate generates `agent.ts` for all agents
2. parent imports are correct
3. tool whitelist expansion is correct from old include/exclude config
4. context file mapping is correct
5. session directories move to `agents/<name>/session/`
6. old `agent.json` files are deleted after successful migration
7. old `.dpi-sessions/` is deleted after successful migration
8. serve rejects old schema and points to `d-pi migrate`
9. runtime loads only `agent.ts`
10. `roles` survive migration but do not load role resources
11. latest session restores correctly from the new path

## Risks

- This is a deliberate breaking schema change with no runtime compatibility layer.
- If migration emits incorrect tool arrays, agents may silently lose capability.
- Role resource blocking is intentional but may surprise users who expect existing role behavior to continue.
- Deleting old schema files after migration means migration correctness must be covered by tests before rollout.
