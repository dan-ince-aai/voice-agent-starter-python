#!/usr/bin/env python3
"""Put your agent on a phone number.

    python deployment/telephony/connect.py

Points a Twilio SIP trunk at AssemblyAI, hands your number to that trunk,
registers the number, and attaches the agent. Every step checks before it
creates, so re-running is safe.
"""

import os
import re
import sys
import urllib.parse
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from lib import (ApiError, aai, load_env, publish_agent, read_agent,  # noqa: E402
                 required, stored_agent_id, twilio)

TRUNKING = "https://trunking.twilio.com/v1/Trunks"
# Where Twilio sends the call. A fixed AssemblyAI address, not something to
# customise.
SIP_URL = "sip:sip.assemblyai.com"


def main() -> None:
    load_env()
    required("ASSEMBLYAI_API_KEY", "get one at https://www.assemblyai.com/dashboard/api-keys")
    account = required("TWILIO_ACCOUNT_SID", "find it on your Twilio console dashboard")
    required("TWILIO_AUTH_TOKEN", "find it on your Twilio console dashboard")
    number = required("TWILIO_PHONE_NUMBER", "E.164 format, like +15551234567")
    trunk_domain = required("TWILIO_TRUNK_DOMAIN", "a name you choose, ending in .pstn.twilio.com")

    if not re.fullmatch(r"\+[1-9]\d{6,14}", number):
        sys.exit(f"TWILIO_PHONE_NUMBER must be E.164, like +15551234567 (got {number})")
    if not trunk_domain.endswith(".pstn.twilio.com"):
        sys.exit(f"TWILIO_TRUNK_DOMAIN must end in .pstn.twilio.com (got {trunk_domain})")

    core = f"https://api.twilio.com/2010-04-01/Accounts/{account}"

    # 1. The agent. A published id means one already exists; otherwise publish
    # the file now, which also writes the new id to .env.
    name = os.environ.get("AGENT", "minimal")
    agent_id = stored_agent_id(name)
    if agent_id:
        print(f"Agent: {agent_id} (already published)")
    else:
        agent = read_agent(name)
        agent_id = publish_agent(agent, name=name)["id"]
        print(f'Agent: {agent_id}, published "{agent["name"]}" from agents/{name}.jsonc')

    # 2. The number has to be one you already bought in Twilio.
    quoted = urllib.parse.quote(number)
    owned = twilio(f"{core}/IncomingPhoneNumbers.json?PhoneNumber={quoted}")
    numbers = owned.get("incoming_phone_numbers", [])
    if not numbers:
        sys.exit(f"{number} is not on this Twilio account. Buy it in the console first.")
    incoming = numbers[0]

    # 3. The trunk, matched by the domain you picked.
    trunk = next(
        (t for t in twilio(TRUNKING).get("trunks", []) if t.get("domain_name") == trunk_domain),
        None,
    )
    if trunk:
        print(f"Trunk: {trunk['sid']} (existing)")
    else:
        trunk = twilio(TRUNKING, {
            "FriendlyName": "AssemblyAI voice agent",
            "DomainName": trunk_domain,
        })
        print(f"Trunk: {trunk['sid']} (created)")

    # 4. Origination sends incoming calls to AssemblyAI.
    origination = twilio(f"{TRUNKING}/{trunk['sid']}/OriginationUrls")
    if any(u.get("sip_url") == SIP_URL for u in origination.get("origination_urls", [])):
        print(f"Origination: already routed to {SIP_URL}")
    else:
        twilio(f"{TRUNKING}/{trunk['sid']}/OriginationUrls", {
            "FriendlyName": "AssemblyAI SIP",
            "SipUrl": SIP_URL,
            "Priority": 1,
            "Weight": 1,
            "Enabled": "true",
        })
        print(f"Origination: routed to {SIP_URL}")

    # 5. Hand the number to the trunk. From here the trunk controls it, and any
    # Voice webhook set on the number itself stops applying.
    if incoming.get("trunk_sid") == trunk["sid"]:
        print(f"Number: {number} already on this trunk")
    elif incoming.get("trunk_sid"):
        sys.exit(f"{number} is attached to a different trunk ({incoming['trunk_sid']}). "
                 "Detach it in the Twilio console and re-run.")
    else:
        twilio(f"{TRUNKING}/{trunk['sid']}/PhoneNumbers", {"PhoneNumberSid": incoming["sid"]})
        print(f"Number: {number} attached to trunk")

    # 6. Register the number with AssemblyAI, unless it already knows it.
    encoded = urllib.parse.quote(number)
    try:
        aai(f"/phone-numbers/{encoded}")
        print(f"Registered: {number} already known to AssemblyAI")
    except ApiError as err:
        if err.status != 404:
            raise
        aai("/phone-numbers/import", method="POST",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            body={"phone_number": number, "termination_uri": trunk_domain})
        print(f"Registered: {number} imported")

    # 7. Attach the agent to the number, then read it back.
    aai(f"/phone-numbers/{encoded}/agent", method="PUT", body={"agent_id": agent_id})
    verified = aai(f"/phone-numbers/{encoded}")
    print(f"Attached: agent {verified.get('agent_id', agent_id)} answers {number}")
    print(f"\nCall {number}.")


if __name__ == "__main__":
    try:
        main()
    except ApiError as err:
        sys.exit(str(err))
