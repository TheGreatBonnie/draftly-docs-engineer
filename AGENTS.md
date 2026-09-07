## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## superpowers

Mandatory skill discipline. Check for applicable skills BEFORE any response
or action — including clarifying questions, exploring the codebase, or
checking files/git state.

Core rules:
1. Scan the trigger table below before EVERY task. If there is even a 1%
   chance a skill applies, invoke it via the `skill` tool by name (do not
   guess paths).
2. Process skills come first, then implementation/domain skills.
   e.g. "build X" -> brainstorming first; "fix bug" -> systematic-debugging first.
3. Announce usage: "Using [skill] to [purpose]".
4. If a skill has a checklist, create one todo per item (todowrite).
5. These thoughts mean STOP and invoke anyway: "simple question",
   "need context first", "let me explore quickly", "overkill",
   "I remember this skill". Action = task = skill check.

Trigger table:
- Starting any conversation .................. using-superpowers
- Creating features/components/functionality . brainstorming
- Multi-step task with a spec ................ writing-plans
- Executing a written plan (new session) ..... executing-plans
- Executing a plan via subagents ............. subagent-driven-development
- 2+ independent tasks ....................... dispatching-parallel-agents
- Implementing any feature/bugfix ............ test-driven-development
- Any bug, failure, unexpected behavior ...... systematic-debugging
- About to claim work complete/fixed ......... verification-before-completion
- Task/major feature done, pre-merge ......... requesting-code-review
- Received review feedback ................... receiving-code-review
- Feature work needing isolation ............. using-git-worktrees
- Branch done, tests pass, ready to merge .... finishing-a-development-branch
- Creating/editing/verifying skills .......... writing-skills

Standard chains:
- Feature: brainstorming -> writing-plans -> using-git-worktrees ->
  executing-plans (or subagent-driven-development) -> TDD per task ->
  requesting-code-review -> verification-before-completion ->
  finishing-a-development-branch
- Bugfix: systematic-debugging -> test-driven-development ->
  verification-before-completion
- Skills work: writing-skills
