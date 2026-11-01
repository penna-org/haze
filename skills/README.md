# hazejs agent skills

[Agent Skills](https://agentskills.io) that teach AI coding agents (Claude Code and other skill-aware agents) to work with hazejs.

| Skill | Use it for |
| --- | --- |
| [`hazejs`](./hazejs/SKILL.md) | Building apps with hazejs: routing, controllers, validation, container and modules, database, auth, queues and realtime, cache / storage / i18n / AI, GraphQL, microservices, testing, CLI and deployment. The entry file points to one reference per area. |
| [`hazejs-migration`](./hazejs-migration/SKILL.md) | Porting an existing Fastify, Express, Koa, Hono or NestJS backend to hazejs while keeping its business code and API contract, and proving the port with the original tests. Distilled from migrating a 32k-line Fastify backend. |
| [`hazejs-contributing`](./hazejs-contributing/SKILL.md) | Working on the framework itself: toolchain, tests, bilingual docs, design records and changesets. |

## Installing

With the [`skills`](https://github.com/vercel-labs/skills) CLI, from your project:

```bash
npx skills add penna-org/haze                                   # pick skills and agents interactively
npx skills add penna-org/haze --skill hazejs --agent claude-code
npx skills add penna-org/haze --list                            # list the skills without installing
```

Add `-g` to install for your user instead of the project, and run `npx skills update` to pull newer versions.

Skills are also plain folders, so you can copy or symlink the ones you need into your agent's skills directory by hand, for example for Claude Code in a project:

```bash
mkdir -p .claude/skills
ln -s /path/to/haze/skills/hazejs .claude/skills/hazejs
ln -s /path/to/haze/skills/hazejs-migration .claude/skills/hazejs-migration
```

or into `~/.claude/skills/` to make them available in every project. The `hazejs-contributing` skill is meant for this repository; link it into `.claude/skills/` here.

## Keeping them accurate

The references summarise `docs/guide/*.md` and are checked against the source. When a change alters public behaviour, update the matching reference together with the guide pages (see `hazejs-contributing`).
