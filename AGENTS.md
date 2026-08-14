# Working on this repo

A standard-library Python starter for the AssemblyAI Voice Agent API. An agent is one file in `agents/`; `publish.py` pushes it to the account; the two front doors in `deployment/` decide where it answers.

```
agents/<name>.jsonc        the agent, as the body of POST /v1/agents
lib.py                     env loading, JSONC parsing, AssemblyAI + Twilio calls
publish.py                 python publish.py
import_agent.py            python import_agent.py <id>, playground agent into a file
deployment/browser/        server.py, serves a page and mints session tokens
deployment/telephony/      connect.py, Twilio SIP trunk and number binding
```

## Run

```sh
cp .env.example .env    # ASSEMBLYAI_API_KEY
python publish.py       # AGENT=<name> to pick one
python deployment/browser/server.py
```

Python 3.9+, no installs. Agents: `minimal`, `keyterms`, `turn-taking`, `byo-llm`, `http-tools`, `exa-search`, `airtable-crm`, `cal-booking`, `dtmf` (keypad entry for PCI compliance).

## How it fits together

Agent files are API request bodies. If a field isn't in the [create-agent reference](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent), it doesn't belong in the file. They use `.jsonc` so each field can carry a comment and a doc link. `parse_jsonc` in `lib.py` strips comments and trailing commas before the file is sent.

`${VAR}` in an agent file is substituted from the environment, the root `.env`, or `agents/<name>.env`, in that order of precedence. Secrets never live in the JSON, and an unresolved variable stops the publish with a message naming it.

Each agent file owns an id, stored as `AGENT_ID_<NAME>`: `agents/http-tools.jsonc` uses `AGENT_ID_HTTP_TOOLS`. Unset, `publish_agent` sends `POST /v1/agents` and writes the returned id under that key. Set, it sends `PUT /v1/agents/{id}`, falling back to a create if that returns 404. A bare `AGENT_ID` overrides every per-file key and is never written to.

Both deployments resolve an id the same way, through `stored_agent_id(name)`. The browser session sends only `{ agent_id }` and the phone number is bound to the same id, which is why behaviour changes belong in the agent file rather than in a deployment.

## Rules

- Standard library only. No pip install, no virtualenv, no requirements to keep current.
- Behaviour goes in `agents/*.jsonc`. Runtime changes go in the deployment that owns them. Anything shared goes in `lib.py`, the only module both deployments import.
- `deployment/browser/app.js` is copied from the [JS starter](https://github.com/dan-ince-aai/voice-agent-starter-js) and should stay identical to it. Audio and transcript fixes belong there first, then here.
- Prefer `http` tools. Client-executed tools can't be answered on a phone call, and `publish.py` warns about them.
- Voices: only IDs from the documented catalog at https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices. Never invent one.
- Never move the API key into client code, commit it, or log it. `.env` and `agents/*.env` are gitignored; keep them that way.
- Only use documented endpoints, and keep the doc links in the agent files accurate, since they are how anyone reading the repo finds the reference.
- Voice-first prompt style: short spoken sentences, no visual formatting, no exclamation marks.
- New agent file: name it after the parameter or integration it demonstrates, not the persona. Comment every non-obvious field with a link to the page that defines it, and add a row to `README.md` and `agents/README.md`. Add it to the JS starter too, so the two stay in step.

## Reference

- [Create an agent](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent) · [Manage agents](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/manage-agents)
- [Tools overview](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview) · [HTTP tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/http-tools)
- [Turn detection and interruptions](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions)
- [Connect your own LLM](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm)
- [Connect to Twilio](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-to-twilio) · [Use your own number](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/twilio-own-number)

## Deploying

`render.yaml` runs the browser deployment; Render sets `PORT` and prompts for `ASSEMBLYAI_API_KEY`. Set `AGENT_ID` there so the deploy connects to a published agent instead of creating its own. Anyone with the deployed URL, or the phone number, runs sessions billed to that key.
