# Phone

Attaches your agent to a phone number you own in Twilio. Twilio passes inbound calls to AssemblyAI over SIP, so there is no media server, audio bridge or webhook to run.

## 1. Clone

```sh
git clone https://github.com/dan-ince-aai/voice-agent-starter-python
cd voice-agent-starter-js
```

## 2. Add credentials

```sh
cp .env.example .env
```

```sh
ASSEMBLYAI_API_KEY=…                              # assemblyai.com/dashboard/api-keys
TWILIO_ACCOUNT_SID=AC…                            # twilio console
TWILIO_AUTH_TOKEN=…                               # twilio console
TWILIO_PHONE_NUMBER=+15551234567                  # a number you already own, E.164
TWILIO_TRUNK_DOMAIN=acme-agent.pstn.twilio.com    # you choose this, must end .pstn.twilio.com
```

## 3. Pick an agent

Any file in [agents/](../../agents/), or one of your own copied from them. Tools need an `http` block to work on a call, since there is no browser to answer a client-side tool.

## 4. Deploy

```sh
AGENT=cal-booking python deployment/telephony/connect.py
```

```
Agent: 8f3c…  published "Cal.com booking showcase"
Trunk: TK7a…  (created)
Origination: routed to sip:sip.assemblyai.com
Number: +15551234567 attached to trunk
Registered: +15551234567 imported
Attached: agent 8f3c… answers +15551234567
```

Call the number.

---

## What it did

1. Published the agent, or used its id from `.env` if it was already published.
2. Created a SIP trunk on your domain.
3. Set its origination URL to `sip:sip.assemblyai.com`.
4. Attached your number to the trunk.
5. Registered the number with AssemblyAI and bound the agent to it.

Each step checks for existing state first, so the script can be re-run safely. To change how the agent behaves, edit its file and run `python publish.py`. The number already points at that agent ID, so Twilio needs no further changes.

## Notes

The trunk takes ownership of the number. Any Voice webhook configured on the number itself no longer applies.

DTMF only works on a phone call. [dtmf.jsonc](../../agents/dtmf.jsonc) collects card digits from the keypad and keeps them out of the transcript, the logs and the model, which is what keeps a payment flow inside PCI compliance.

Twilio bills the inbound minutes and AssemblyAI bills the session, so a live number draws on both accounts.

## When it fails

| Message | Cause |
| --- | --- |
| `is not on this Twilio account` | The number isn't in your account, or isn't in E.164 format. |
| `is attached to a different trunk` | Detach it in the Twilio console, then re-run. |
| `Twilio POST /v1/Trunks failed (400)` | The SIP domain is taken or malformed. Choose another `*.pstn.twilio.com`. |
| Call connects, then silence | The origination URL must be exactly `sip:sip.assemblyai.com` and enabled. |

## Documentation

[Connect to Twilio](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-to-twilio) · [Use your own number](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/twilio-own-number)
