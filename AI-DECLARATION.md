---
version: "0.1.2"
level: auto
processes:
  design: copilot
  implementation: auto
  testing: auto
  documentation: auto
  review: auto
  deployment: copilot
---

This format is based on [AI-DECLARATION.md](https://ai-declaration.md/en/0.1.2).

## Notes

- Grimoire is built with Claude Code (Anthropic). The owner directs the
  project: they decide what gets built, answer the design questions and pick
  between the UI alternatives they're shown. They don't write the code.
- **Design: copilot.** Claude proposes the architecture, data model and page
  layouts, and asks the owner whenever a choice is theirs to make. Those
  questions and answers are recorded on the GitHub issues. The owner set the
  visual direction and the product rules that `CLAUDE.md` records.
- **Implementation, testing and documentation: auto.** Claude Code agents
  write the code, the tests, the README, the Help Guide and the Change log.
  Each issue is built on its own branch.
- **Review: auto.** Every pull request is reviewed by a separate agent (never
  the one that wrote it), on top of automated gates (`tools/gates.js`, also
  run in CI). A risky change also needs the owner's `approved` label before
  it can land.
- **Deployment: copilot.** Claude wrote the merge lane and deploy tools and
  runs them, and asks the owner before each release goes out.
- The process is written down in `CLAUDE.md`, `docs/flows/pipeline.dot` and
  `.claude/skills/`.
