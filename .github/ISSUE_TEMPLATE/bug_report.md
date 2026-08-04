---
name: Bug report
about: Something in evestack doesn't work the way it should
labels: bug
---

**What happened**


**What you expected instead**


**Steps to reproduce**
Ideally against a fresh `npx create-evestack test && cd test`. If it only reproduces in a
larger project, say what's different.

**Where**
- [ ] the agent (`templates/default`, or your scaffolded project)
- [ ] the dashboard (`packages/dashboard`)
- [ ] `create-evestack`
- [ ] `@evestack/composio`
- [ ] a registry item (`eve add @evestack/...`)

**Environment**
- evestack version / commit:
- `node -v`:
- OS:
- `docker --version`:
- Model provider (OpenAI / Anthropic / Ollama):

**Logs**
Relevant output from `.eve/logs/`, the dashboard's terminal, or `docker compose logs`. Redact
API keys.
