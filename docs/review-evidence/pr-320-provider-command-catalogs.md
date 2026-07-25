# PR 320 live provider-command evidence

This transcript was captured from live subscription-backed Codex and Claude
sessions on Pine after Ponderosa assembled the operator-facing catalogs. Claude's
built-ins are provider-advertised and provider-rendered. Codex's `status` and
`compact` entries are inserted and dispatched by the adapter over provider RPC;
their underlying session, context, and rate-limit data comes from Codex app-server.

```text
verified_at_utc=2026-07-25T23:22:01Z
host=pine
head=fd84436318b25ad940a837a182de94493db60332
codex_version=codex-cli 0.144.1
claude_version=2.1.206 (Claude Code)
```

The runnable evidence checkout is intentionally retained at:

```text
/home/phoenix/khaleel/ponderosa-pr320-fd84436-evidence
```

Preserved files:

```text
98322dfd5e9ff3ea2a63b2ba32c1d36e210960ecab8758720a68199b4b2926f8  provider-command-evidence.mjs
833ee7e69bb22fd3e16e56e2be440fdbf417fe305558b593a671070b0749d375  live-provider-command-output.txt
```

## Codex adapter command catalog

```text
name	source	status	invocation
figma:figma-code-connect	plugin	available	prompt
figma:figma-create-new-file	plugin	available	prompt
figma:figma-design-to-code	plugin	available	prompt
figma:figma-generate-design	plugin	available	prompt
figma:figma-generate-diagram	plugin	available	prompt
figma:figma-generate-library	plugin	available	prompt
figma:figma-implement-motion	plugin	available	prompt
figma:figma-swiftui	plugin	available	prompt
figma:figma-use	plugin	available	prompt
figma:figma-use-figjam	plugin	available	prompt
figma:figma-use-motion	plugin	available	prompt
figma:figma-use-slides	plugin	available	prompt
github:gh-address-comments	plugin	available	prompt
github:gh-fix-ci	plugin	available	prompt
github:github	plugin	available	prompt
github:yeet	plugin	available	prompt
gmail:gmail	plugin	available	prompt
gmail:gmail-inbox-triage	plugin	available	prompt
openai-templates:artifact-template-analytics-dashboard	plugin	available	prompt
openai-templates:artifact-template-business-review	plugin	available	prompt
openai-templates:artifact-template-design-report	plugin	available	prompt
openai-templates:artifact-template-experiment-analysis	plugin	available	prompt
openai-templates:artifact-template-financial-budget	plugin	available	prompt
openai-templates:artifact-template-investment-committee-memo	plugin	available	prompt
openai-templates:artifact-template-legal-memorandum	plugin	available	prompt
openai-templates:artifact-template-market-trends-report	plugin	available	prompt
openai-templates:artifact-template-minimal-letterhead	plugin	available	prompt
openai-templates:artifact-template-operating-calendar	plugin	available	prompt
openai-templates:artifact-template-operating-review	plugin	available	prompt
openai-templates:artifact-template-project-kickoff	plugin	available	prompt
openai-templates:artifact-template-project-tracker	plugin	available	prompt
openai-templates:artifact-template-sales-pipeline	plugin	available	prompt
openai-templates:artifact-template-simple-dark-mode	plugin	available	prompt
openai-templates:artifact-template-simple-light-mode	plugin	available	prompt
openai-templates:artifact-template-strategy-memorandum	plugin	available	prompt
openai-templates:artifact-template-system-design	plugin	available	prompt
openai-templates:artifact-template-team-alignment	plugin	available	prompt
openai-templates:artifact-template-three-statement-forecast	plugin	available	prompt
outlook-email:outlook-email	plugin	available	prompt
outlook-email:outlook-email-inbox-triage	plugin	available	prompt
outlook-email:outlook-email-reply-drafting	plugin	available	prompt
outlook-email:outlook-email-shared-mailboxes	plugin	available	prompt
outlook-email:outlook-email-subscription-cleanup	plugin	available	prompt
outlook-email:outlook-email-task-extraction	plugin	available	prompt
test-skill	skill	available	prompt
imagegen	skill	available	prompt
openai-docs	skill	available	prompt
plugin-creator	skill	available	prompt
skill-creator	skill	available	prompt
skill-installer	skill	available	prompt
compact	built-in	available	runtime
status	built-in	available	runtime
```

Codex app-server does not advertise an invokable `status` slash command.
Ponderosa's Codex adapter inserts this catalog entry, validates it through the
same adapter catalog in `invokeCommand()`, and renders provider RPC data through
`formatCodexStatus()`. The `compact` entry is likewise adapter-implemented and
passes through to `thread/compact/start`.

## Codex `/status` rendered output

```text
Codex session 019f9b95-eeaf-7110-9621-380ea9048bdc · Model gpt-5.6-sol · Context usage not yet reported · GPT-5.3-Codex-Spark: 7d limit 0% used · codex: 7d limit 4% used
```

## Claude filtered provider-advertised command catalog

```text
name	source	status	invocation
design-sync	skill	available	prompt
dataviz	skill	available	prompt
update-config	skill	available	prompt
verify	skill	available	prompt
debug	skill	available	prompt
code-review	skill	available	prompt
simplify	skill	available	prompt
batch	skill	available	prompt
fewer-permission-prompts	skill	available	prompt
doctor	skill	available	prompt
loop	skill	available	prompt
schedule	skill	available	prompt
claude-api	skill	available	prompt
run	skill	available	prompt
run-skill-generator	skill	available	prompt
compact	built-in	available	prompt
context	built-in	available	prompt
mcp	built-in	available	prompt
usage	built-in	available	prompt
insights	built-in	available	prompt
recap	built-in	available	prompt
```

## Claude `/context` rendered output

```text
## Context Usage

**Model:** claude-sonnet-5
**Tokens:** 21k / 967k (2%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 8.8k | 0.9% |
| System tools | 10.3k | 1.1% |
| System tools (deferred) | 15.3k | 1.6% |
| Skills | 1.9k | 0.2% |
| Messages | 8 | 0.0% |
| Free space | 913k | 94.4% |
| Autocompact buffer | 33k | 3.4% |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| dataviz | Built-in | ~380 |
| update-config | Built-in | ~240 |
| keybindings-help | Built-in | ~80 |
| verify | Built-in | ~150 |
| code-review | Built-in | ~140 |
| simplify | Built-in | ~60 |
| fewer-permission-prompts | Built-in | ~60 |
| loop | Built-in | ~120 |
| schedule | Built-in | ~130 |
| claude-api | Built-in | ~360 |
| run | Built-in | ~120 |
| init | Built-in | ~20 |
| review | Built-in | ~30 |
| security-review | Built-in | ~30 |
```

## Claude `/usage` rendered output

```text
You are currently using your subscription to power your Claude Code usage

Current session: 32% used · resets Jul 26, 4:10am (UTC)
Current week (all models): 58% used · resets Jul 27, 6am (UTC)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 209 requests · 15 sessions
  41% of your usage was while 4+ sessions ran in parallel
  34% of your usage was at >150k context
  Top MCP servers: ponderosa 41%

Last 7d · 769 requests · 34 sessions
  21% of your usage was at >150k context
  20% of your usage was while 4+ sessions ran in parallel
  Top skills: /code-review 3%
  Top MCP servers: ponderosa 24%
```
