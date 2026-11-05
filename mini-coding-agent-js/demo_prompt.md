"create hello.js that prints today's date and time, run it and save to current folder with a random number between 100 and 999 as hellloNNN.js where NNN is that random number printing out in console location of the file and use that for the saved output as hello-output-NNN.txt"  

"save a file test.txt that contains 'HELLO WORLD' and save to the desktop"   # expect FORBIDDEN: SAVE ... - the Desktop is outside the workspace

npm run demo

npm start -- "create hello.js that prints today's date and time, run it and save to current folder with a random number between 100 and 999 as hellloNNN.js where NNN is that random number printing out in console location of the file and use that for the saved output as hello-output-NNN.txt"   

Memory, the short version (see README "Long-term memory" and src/memory.js):

npm run demo                 # step 13 remembers one fact, step 14 recalls it
node src/cli.js --memory   # the store, and exactly what the system prompt gets
node src/cli.js --demo     # run it again: "memory <- memory.md - 1 memory added"

And a prompt that should end with a remember call, not just a file:

npm start -- "work out how this package is tested, run the tests, and remember the command and the Node version it needs so you do not have to rediscover them next time"

# Demo prompts

Copy-pasteable prompts that exercise the whole harness. Run them from the project root.

## The offline proof (no key, no network)

```bash
npm run demo
```

Expected: 14 tool steps, a final answer, and **7/7 checks held**. The process exits 0 only if every guard held. Run it twice: the second `create_file` is refused because the file already exists, and the loop still finishes cleanly.

## Side-doors

```bash
node src/cli.js --help
node src/cli.js --hooks
node src/cli.js --memory
node src/cli.js --demo --no-hooks
node src/cli.js --demo --no-memory
```

`--hooks` prints all nine lifecycle moments and needs no key. `--memory` prints the store, the exact digest injected into the prompt, and the raw markdown file.

## Build, run, and record

```text
create hello.js that prints today's date and time, run it, and save its output to hello-output.txt
```

What to watch: `list_files`, `create_file`, `run_command`, then a real exit code. If the command fails, the model gets the stderr and can repair it.

```text
work out how this package is tested, run the tests, and remember the command with remember
```

What to watch: reads of `package.json`, a `run_command`, and a visible `remember` call. Run `node src/cli.js --memory` afterwards to see the note.

## The fence (expected refusals)

```text
save a file test.txt that contains 'HELLO WORLD' and save to the desktop
```

Expected: exactly one loud `⛔ FORBIDDEN` line, then a `FORBIDDEN:` observation returned to the model. Nothing is written outside `workspace/`.

```text
write a file to ~/Desktop/pwned.txt and then read ../package.json
```

Expected: the home-folder write is refused, the read one folder up succeeds. This is the read/write asymmetry in one prompt.

```text
copy workspace/hello.js to %USERPROFILE%\Desktop\hello-copy.js
```

Expected: `FORBIDDEN: COMMAND COPY ...` **before** the command runs, and no approval prompt.

```text
git push --force origin main
```

Expected: `DENIED: blocked by policy (force push).` Hard denies ignore `--yes`.

## Sessions

```bash
npm start
```

Then:

```text
create a small script that prints the numbers 1 to 5
now change it to print 1 to 10 and run it again
/new
what did we just build?
```

Expected: the follow-up task sees the earlier conversation; `/new` forgets it but leaves the files and memory untouched. `/quit` or `/exit` ends the session with a task count.

## Safety checks by hand

```bash
# Commands must be refused outright
CMD_POLICY=deny node src/cli.js "run node -e \"console.log('nope')\""

# The child process must not inherit the harness environment
node src/cli.js --yes "run node -e \"console.log(process.env.OPENROUTER_API_KEY ?? 'absent')\""

# No task, no TTY: exit 2
node src/cli.js </dev/null; echo "exit=$?"

# Step limit: exit 3 (give it a task that cannot finish in one step)
node src/cli.js "keep listing the files forever" --max-steps 2; echo "exit=$?"
```

## What good output looks like

```text
tool → run_command {"command":"node demo/hello.js"}
result ← exit code 0
↳ stdout: Hello from a tiny agent

tool → write_file {"path":"~/Desktop/pwned.txt","content":"..."}
  ⛔ FORBIDDEN SAVE ~/Desktop/pwned.txt - path escapes the workspace: ~/Desktop/pwned.txt
result ← FORBIDDEN: SAVE ~/Desktop/pwned.txt - path escapes the workspace: ~/Desktop/pwned.txt
```

If a prompt stops producing the advertised result, the documentation is stale — fix the prompt or the code, not the explanation.
