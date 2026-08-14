# agents/

One file per agent. The JSON is the request body for `POST /v1/agents`, with no wrapper fields and no keys the starter invents.

The files use the `.jsonc` extension so that each field can carry a comment and a link to the documentation page defining it. Comments and trailing commas are removed before the file is sent.

## Writing your own

```sh
cp http-tools.jsonc my-agent.jsonc
AGENT=my-agent python publish.py
```

Or start from an agent that already exists on your account, which is the path from the playground into code:

```sh
python import_agent.py <agent-id>
```

Credentials are write-only on the API, so tool header values and LLM keys do not come back with it. The import says which ones to put back.

For credentials, write `${MY_KEY}` anywhere in the file and put the value in `.env`, or in `agents/my-agent.env` if only this agent uses it. Both are gitignored. If a variable is missing, publishing stops and names it.

```jsonc
"headers": [{ "name": "x-api-key", "value": "${EXA_API_KEY}" }]
```

---

## The files

| File | Demonstrates |
| --- | --- |
| [minimal.jsonc](minimal.jsonc) | `name`, `system_prompt` and `voice`, plus the defaults applied to everything else |
| [keyterms.jsonc](keyterms.jsonc) | `input.keyterms`, for names and jargon a transcriber would otherwise guess at |
| [turn-taking.jsonc](turn-taking.jsonc) | `input.turn_detection`, the silence thresholds and interruption handling |
| [byo-llm.jsonc](byo-llm.jsonc) | `llm`, pointing at the AssemblyAI gateway or any OpenAI-compatible endpoint |
| [http-tools.jsonc](http-tools.jsonc) | `tools[].http`, requests AssemblyAI makes on the agent's behalf |
| [exa-search.jsonc](exa-search.jsonc) | the same mechanism with an API key attached |
| [airtable-crm.jsonc](airtable-crm.jsonc) | one tool that reads records and one that writes them |
| [cal-booking.jsonc](cal-booking.jsonc) | two tools used in sequence: check availability, then book |
| [dtmf.jsonc](dtmf.jsonc) | `dtmf_collected_arguments`, for PCI compliance: keypad digits the model never sees |

## Two things to know

Tools with an `http` block are executed by AssemblyAI, so they work in a browser tab and on a phone call. Tools without one have to be answered by whatever holds the session, and a phone call has nothing to answer them. `python publish.py` prints a warning when a tool is missing it.

System prompts are read aloud, so write for speech: short sentences, no lists or headings. State what the agent is, what it must not do, and what to do when it does not know something.

## Documentation

[Create an agent](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent) · [Voices](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices) · [Turn detection](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions) · [HTTP tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/http-tools) · [Custom LLM](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm) · [Prompting guide](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/prompting-guide)
