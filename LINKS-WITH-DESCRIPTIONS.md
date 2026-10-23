# Link Descriptions

## AI Agents in HTML

My video series:
https://www.youtube.com/playlist?list=PLsszRSbzjyvkWzP6wtfx_LK441YGFkziR

A video playlist walking through building AI agents that operate directly on HTML and the web browser — my own series on agent workflows for front-end/web-page tasks.

Inspired by:

https://www.youtube.com/watch?v=hKVhRA9kfeM

"Python: Create a ReAct Agent from Scratch" (Alejandro AO). A hands-on tutorial that builds a ReAct (Reason–Act–Observe) agent from first principles in pure Python, showing the core loop of reasoning, tool calling, and observing results without any agent framework.

https://www.youtube.com/watch?v=1OLrT3dEzhA

"Building AI Agents from Scratch | Full Course" (The Neural Maze). A full-length course that constructs AI agents from the ground up, covering the agentic loop, tool use, and how to assemble a working agent step by step.

## Build your own mini Coding Agent

https://github.com/Python-Test-Engineer/brighton-web-dev-meetup-nov-2026

The repo for this talk at the BrightonDev.ai Meetup (Nov 2026) — contains the talk notes, links, and demo materials for building and understanding mini coding agents.

https://github.com/avbiswas/neural-code

"NeuralCode" — a minimal coding agent harness in Python, built to show how the pieces of a coding agent fit together. Companion repo to the Neural Breakdown video on building a coding agent from scratch; cycle through the commits to see it built stage by stage. Includes shell/read/write/edit tools, skills directories, subagents for codebase exploration, todo tracking, context compaction, and git-aware reminders.

https://github.com/Python-Test-Engineer/mini-claude

A deliberately minimal "very basic Claude Code" in Python — a stripped-down coding agent that reads files, reasons, and takes action through the Claude-style agentic loop. Comes with an EXPLAINER.md that details exactly how it works internally.

https://github.com/hugobowne/build-your-own-ai-assistant/tree/main

"Koroku: Build Your Own AI Agent From Scratch" — the companion code repo for the OpenClawd From Scratch workshop. It builds an agent incrementally on the Gemini SDK: first a simple tool-calling loop ("It's Alive"), then hooks plus HTTP and Telegram integration ("Phone Home"), then SQLite-backed persistent memory and conversation compaction ("Total Recall").

https://hugobowne.substack.com/p/building-agents-that-build-themselves

"Building Agents That Build Themselves" — a full code walkthrough by Hugo Bowne-Anderson of the same "OpenClaw from Scratch" workshop. It covers the core agent loop, context management, memory compaction, letting agents write and hot-reload their own tools via a factory pattern, automatic actions through hooks, Telegram integration, and sandboxed deployment with Modal.

https://sidbharath.com/blog/build-a-coding-agent-python-tutorial/

"Build a Coding Agent in Python: Step-by-Step Tutorial" — reverse-engineers Claude Code to build a "Baby Code" agent using only Python and the Claude API. Builds it in four layers: a minimal ReAct loop, guarded file/command tools, context management for larger codebases, and a verification loop that runs tests and improves from failures.

https://www.youtube.com/watch?v=3GjE_YAs03s

"How Claude Code Works (By Building It)" (Rivaan Ranawat) — recreates Claude Code's mechanics from scratch, demystifying how a production coding agent reasons, uses tools, and manages context under the hood.

## Data Intelligence Agent

https://github.com/Python-Test-Engineer/data-intelligence-agent

A Claude Code–powered data intelligence environment built around a FastAPI CSV analysis service. Upload any CSV and get automated charts, statistical reports, AI-generated insights, and a searchable SQL query library — all driven by slash commands and autonomous agents.

## Demo of Harness Engineering

https://www.youtube.com/watch?v=C_GG5g38vLU

"Harnesses in AI: A Deep Dive" — a conference talk by Tejas Kumar (IBM) on the concept of the AI/agent harness: everything around the model (tool registry, context management, guardrails, the agent loop, and a verify step) that grounds it in a stable environment. He live-builds a bare-bones "poor man's harness" for a browser-use agent using a deliberately weak, cheap model, and shows the harness radically improving its performance — all without changing the model or a single prompt word.

## Build Agentic Workforce

https://www.youtube.com/watch?v=1OLrT3dEzhA

"Building AI Agents from Scratch | Full Course" (The Neural Maze) — a full-length course that constructs AI agents from the ground up, covering the agentic loop, tool use, and how to assemble a working agent step by step. A solid foundation for then composing those individual agents into a coordinated workforce.