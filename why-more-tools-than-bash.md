# Why More Than One Tool? Dedicated Tools vs Bash-Only

Bash alone is enough to do everything, so the extra tools are about making the agent more reliable, safer and cheaper, not more capable.

## Advantages

| Advantage | Tool(s) affected | Detail |
|---|---|---|
| 1. Reliability of the operation | read | Line numbers, truncation, encoding handling, refuses binaries. With bash the model must recall `cat -n \| head -200` or `sed -n` and sometimes gets it wrong. |
| 1. Reliability of the operation | edit | Exact string replace fails loudly if the match is missing or not unique, catching mistakes before a file is corrupted. Avoids sed escaping, heredoc and quoting problems. |
| 1. Reliability of the operation | write | Whole-file creation without shell quoting problems (backticks, `$`, quotes inside code). |
| 2. Permissions and safety | all | One bash tool means everything is "run arbitrary shell", so gating is coarse. Separate tools allow per-tool policy. Checking a structured `read(path)` is trivial; parsing `cat foo; rm -rf ~` is error-prone. |
| 3. Token efficiency and context control | read, grep | Tools can bound their own output (cap matches, paginate). Raw `cat` of a 10,000-line file or noisy `find` floods the context window. |
| 4. Tool-use accuracy | all | Models are trained on tool schemas. Typed params (`path`, `old_string`, `new_string`) are called correctly more often than free-form shell. The schema doubles as documentation. |
| 5. Determinism and portability | all | Python tools behave identically on Windows, Linux and Mac. Shell commands (`cat`, `grep`, `sed`) differ or don't exist on Windows. |
| 6. Better observability | all | Structured calls are easy to log, replay, diff and display. Supports the self-learning goal: analyse which tools succeed, fail or get retried. |

## Permissions Policy (Advantage 2 in Practice)

- `read`, `grep`, `glob`: auto-approve (harmless)
- `edit`, `write`: approve, or auto-approve inside the project directory
- `bash`: always ask, or run in a sandbox

## Why Not Too Many?

- **Schema token cost:** each tool schema is sent on every request.
- **Choice overload:** more tools means the model picks the wrong one or dithers between overlapping ones.
- **Overlap:** if `search`, `grep` and `find_in_files` all exist, selection quality drops.
- **Diminishing returns:** beyond roughly 6 to 8 tools.

## The Sweet Spot

Tools that are frequent, error-prone via shell, or need different permissions.

| Tool | Tier | Why it earns its place | Suggested permission |
|---|---|---|---|
| `read` | Core | Bounded output, line numbers | Auto-approve |
| `edit` | Core | Safe exact-match changes, fails loudly | Approve, or auto-approve inside project dir |
| `write` | Core | Whole-file creation without quoting problems | Approve, or auto-approve inside project dir |
| `bash` | Core | Escape hatch for everything else (tests, git, installs) | Always ask, or run in a sandbox |
| `grep` | Optional | Capped-output search; stops raw `find`/`grep` token burn | Auto-approve |
| `glob` | Optional | Capped-output file discovery | Auto-approve |

## How to Decide for Your Own Harness

1. Start with bash only.
2. Watch the logs for repeated shell patterns that fail or need a different permission level.
3. Promote that pattern to a first-class tool.

This fits the self-learning goal: the harness can surface these patterns itself.
