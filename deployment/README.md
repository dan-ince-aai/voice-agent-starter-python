# deployment/

Where the agent answers. Both resolve the same id for a given `AGENT`, so one published agent serves both.

| | | |
| --- | --- | --- |
| [browser/](browser/) | `python deployment/browser/server.py` | A page with a call button, for iterating on an agent. |
| [telephony/](telephony/) | `python deployment/telephony/connect.py` | A phone number, over a Twilio SIP trunk. |

Neither defines the agent. Behaviour lives in [agents/](../agents/).
