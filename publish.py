#!/usr/bin/env python3
"""Push agents/<name>.jsonc to your AssemblyAI account.

    python publish.py
    AGENT=exa-search python publish.py

The first run creates the agent and writes AGENT_ID to .env. Later runs update
that same agent, so a browser tab or phone number pointed at it picks up the
change on the next call.
"""

import os
import sys

from lib import ApiError, load_env, publish_agent, read_agent, required


def main() -> None:
    load_env()
    required("ASSEMBLYAI_API_KEY", "get one at https://www.assemblyai.com/dashboard/api-keys")

    name = os.environ.get("AGENT", "minimal")
    agent = read_agent(name)
    result = publish_agent(agent)

    verb = "Created" if result["created"] else "Updated"
    print(f'{verb} "{agent["name"]}" from agents/{name}.jsonc')
    print(f"AGENT_ID={result['id']}")
    if result["created"]:
        print("Saved to .env." if result["saved"]
              else "Could not write .env. Set AGENT_ID yourself to keep updating this agent.")

    # Tools with an http block are called by AssemblyAI, so they work in a
    # browser tab and on a phone call. Anything else needs whoever holds the
    # session to answer it, and a phone call has nobody.
    unanswered = [tool["name"] for tool in agent.get("tools", []) if not tool.get("http")]
    if unanswered:
        have = "have" if len(unanswered) > 1 else "has"
        print(f"\nWarning: {', '.join(unanswered)} {have} no http block, "
              "so nothing answers it on a phone call.")


if __name__ == "__main__":
    try:
        main()
    except ApiError as err:
        sys.exit(str(err))
