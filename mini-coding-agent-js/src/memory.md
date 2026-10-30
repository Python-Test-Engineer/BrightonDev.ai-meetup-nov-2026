# memory

Long-term notes this agent keeps between runs. One bullet per memory:
`- [tag] text _(YYYY-MM-DD)_` where tag is fact | pref | fix | gotcha.

This file IS the store - edit it by hand, delete a wrong line, or commit it.
The agent reads a bounded slice at the start of a run and can search the rest
with the `recall` tool.

- [pref] The user's name is Craig. _(2026-10-28)_
- [pref] The user lives in Brighton, UK. _(2026-10-28)_
- [gotcha] The run_command shell in this sandbox is Windows cmd.exe, so Unix tools like `cat`, `ls` may fail; use `type`, `dir` etc. instead. _(2026-10-28)_
- [pref] The user is a Python developer. _(2026-10-28)_
- [pref] The user has two dogs. _(2026-10-28)_
- [gotcha] In this workspace, create_file/write_file/edit_file writes go to a virtual layer that the run_command (cmd.exe) shell cannot see: `node hello.js` fails with MODULE_NOT_FOUND and `dir` shows only .gitkeep right after a write. Writing the same file via the shell (PowerShell [IO.File]::WriteAllLines) m _(2026-10-30)_
- [fact] Craig's Desktop path on this machine is C:\Users\mrcra\Desktop (reachable from run_command as %USERPROFILE%\Desktop) and Node v24 is on PATH. _(2026-10-30)_
- [fact] The sandbox demo script lives at demo/hello.js and is safe to regenerate with create_file. _(2026-10-30)_
- [gotcha] This repo's root package.json has "type": "module", so any .js file run with node in the workspace must use ESM syntax (import fs from 'node:fs'; fileURLToPath(import.meta.url)); require() throws "require is not defined in ES module scope". _(2026-10-30)_
- [fix] Correction to an earlier note: files written with create_file/write_file ARE visible to the run_command cmd.exe shell in this workspace (dir lists them and node runs them normally), so no PowerShell workaround is needed. _(2026-10-30)_
- [gotcha] This workspace's sandbox blocks writing outside the workspace root: create_file with an absolute path like C:\Users\mrcra\Desktop\test.txt returns FORBIDDEN, and run_command refuses `copy` to %USERPROFILE%\Desktop with "the shell would write outside the sandbox" - so "save to the desktop" requests c _(2026-10-30)_
