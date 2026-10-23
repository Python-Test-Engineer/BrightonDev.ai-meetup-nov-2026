# Building Agent Workforces in Python: Loops Within Loops

An agent workforce is a set of AI agents, each with a role, coordinated by code. In Python, the whole thing is built from nested loops, each one operating at a different level.

## The three nested loops

### 1. The agent loop (innermost): think, act, observe

Each agent runs a loop where the model decides what to do, calls a tool, reads the result, and repeats until the task is done.

```python
def run_agent(role, task, tools, max_steps=10):
    messages = [{"role": "user", "content": task}]
    for step in range(max_steps):          # safety limit
        reply = call_llm(role, messages, tools)
        if reply.is_final:                 # agent says "I'm done"
            return reply.text
        result = tools[reply.tool_name](**reply.tool_args)
        messages.append({"role": "tool", "content": result})
    return "Stopped: step limit reached"
```

### 2. The workforce loop (middle): hand tasks between agents

A coordinator loops over a task list and passes each one to the right specialist agent, feeding one agent's output into the next.

```python
team = {"researcher": research_tools, "analyst": analysis_tools, "writer": writing_tools}

def run_workforce(tasks):
    results = {}
    for task in tasks:                     # each task in the plan
        agent = pick_agent(task)           # route to a specialist
        results[task] = run_agent(agent, task, team[agent])
    return results
```

### 3. The improvement loop (outermost): learn from results

After each run, the system reviews its outcomes, stores what worked, and feeds those lessons into the next run. This is how skills get updated as the business works.

```python
lessons = load_lessons()                   # saved from previous runs

while True:                                # runs continuously, or per job
    tasks = plan_tasks(new_job, lessons)
    results = run_workforce(tasks)
    review = critic_agent(results)         # score the work, find mistakes
    lessons = update_lessons(lessons, review)
    save_lessons(lessons)                  # persists to a file or database
```

## How they fit together

```
while True:                    # IMPROVEMENT: learn between jobs
    for task in tasks:         # WORKFORCE: route work to agents
        for step in range(n):  # AGENT: think, act, observe
            ...
```

| Loop | Question it answers | Ends when |
|---|---|---|
| Agent | "How do I finish this one task?" | Task is done or step limit hit |
| Workforce | "Who does which task, in what order?" | All tasks complete |
| Improvement | "What should we do better next time?" | You stop it |

## Key points for students

- **Always set limits.** Every loop needs an exit condition (`max_steps`, a budget, a timeout), otherwise agents can run forever and burn money.
- **Tools are just Python functions.** An agent's "skills" are functions it can call, such as querying a database or writing a file.
- **Memory is what makes it self-learning.** The outer loop only improves things if lessons are saved somewhere (a JSON file, a database) and loaded into the agents' instructions next time.
- **Add a critic.** A separate reviewer agent catching errors is what turns repetition into improvement.

## Starter exercise

Build a two-agent version (one researcher, one writer) with a single saved `lessons.json` file, then watch how the second run differs from the first.
