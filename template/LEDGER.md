---
type: Reference
title: How this ledger works
description: The four object types, when agents read and write each, and the rules.
---
# Ledger

Shared memory for every agent on the team. One markdown file per object, YAML frontmatter, committed to git. Agents read it through the `ledger` MCP server; humans read it on GitHub. The format is [OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

Four object types. Each has one moment an agent should read it and one moment it should write it.

| type | read before | write when | kills |
|---|---|---|---|
| `definitions/` | writing any query | a metric is computed with no definition, or a definition changes | different numbers for the same metric |
| `findings/` | starting an analysis | an analysis finishes | rework |
| `changes/` | attributing a metric move | something ships | misattribution |
| `decisions/` | proposing direction | a direction is chosen, dropped, or reversed | agents diverging |

Rules:
- One object per file. File name is the id. Never edit an old object; record a new one with `supersedes`. The old one becomes `deprecated` and drops out of the brief.
- A number without a definition and a data window is not a finding.
- A finding is an argument: inputs, method, and assumptions (explicit and implicit, at least one implicit). A decision lists its context and every option considered, including "do nothing". The tool rejects records without these. Shape follows MADR for decisions and ICD 203 / the Key Assumptions Check for findings.
- Record under a human's name (`generated.by: human:<name>`). Agents are ephemeral; people own claims.
- Don't add a fifth type until an agent visibly needed something and couldn't find it.

Generated files, do not edit: `README.md` (dashboard), `index.md` in each directory, `log.md`.
