#!/usr/bin/env python3
"""Talk to your agent from a browser tab.

    python deployment/browser/server.py

The API key stays in this process; the page only gets 60-second tokens.
"""

import copy
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))

from lib import ApiError, aai, load_env, publish_agent, read_agent, required  # noqa: E402


def resolve_agent() -> dict:
    """AGENT_ID set means the agent is managed elsewhere, so use it as it is."""
    agent_id = os.environ.get("AGENT_ID")
    if agent_id:
        try:
            agent = aai(f"/agents/{agent_id}")
        except ApiError as err:
            sys.exit(f"Could not load AGENT_ID {agent_id}: {err}")
        return {"id": agent_id, "name": agent.get("name") or "Your agent"}
    name = os.environ.get("AGENT", "minimal")
    agent = read_agent(name)
    try:
        result = publish_agent(agent, reuse_by_name=True)
    except ApiError as err:
        sys.exit(f"Could not publish agents/{name}.jsonc: {err}")
    verb = "Created" if result["created"] else "Updated"
    print(f'{verb} "{agent["name"]}" from agents/{name}.jsonc')
    return {"id": result["id"], "name": agent["name"]}


def public_agent(agent: dict) -> dict:
    """Read-only view of the stored agent. The API keeps header values and llm
    keys write-only; these deletes hold even if that changes. The system prompt
    is in here, so a public deployment shows it to anyone who opens the page."""
    copied = copy.deepcopy(agent)
    for tool in copied.get("tools", []):
        for header in tool.get("http", {}).get("headers", []):
            header["value"] = "<hidden>"
    for llm in copied.get("llm", []):
        llm.pop("api_key", None)
    return copied


AGENT = None
PAGE = ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/token":
            try:
                token = aai("/token?product=voice_agent&expires_in_seconds=60")
                self._send(200, json.dumps(token).encode(), "application/json")
            except ApiError as err:
                print(err)
                self._send(502, b'{"error":"token request failed"}', "application/json")
            return
        if path == "/agent":
            try:
                agent = aai(f"/agents/{AGENT['id']}")
                self._send(200, json.dumps(public_agent(agent)).encode(), "application/json")
            except ApiError as err:
                print(err)
                self._send(502, b'{"error":"could not load the agent"}', "application/json")
            return
        if path == "/app.js":
            self._send(200, (HERE / "app.js").read_bytes(), "text/javascript")
            return
        self._send(200, PAGE.encode(), "text/html")

    def log_message(self, *args) -> None:  # quiet; errors are printed above
        pass


def main() -> None:
    global AGENT, PAGE
    load_env()
    required("ASSEMBLYAI_API_KEY", "get one at https://www.assemblyai.com/dashboard/api-keys")

    AGENT = resolve_agent()
    print(f"Agent: {AGENT['id']}")
    PAGE = ((HERE / "index.html").read_text()
            .replace("{{AGENT_NAME}}", AGENT["name"])
            .replace("{{AGENT_JSON}}", json.dumps(AGENT).replace("<", "\\u003c")))

    # PORT when set, otherwise 3000 and up until one is free.
    fixed = os.environ.get("PORT")
    port = int(fixed) if fixed else 3000
    while True:
        try:
            server = ThreadingHTTPServer(("", port), Handler)
            break
        except OSError:
            if fixed or port >= 3010:
                raise
            port += 1

    print(f"Talk to it: http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    main()
