# elastic-agent enrollment notes

Non-secret record of the agent-bus enrollment steps. This file intentionally
contains **no** invite codes, private keys, or secret-store content. The invite
(file `tmp/elastic-invite.json`, mode 0600) and the identity/credential store
(`tmp/elastic-identity/`, and `$HOME/.agent-bus/elastic-agent`) are kept out of
the repository by `.gitignore`.

## Target bus details (from `tmp/elastic-agent-onboarding.md`)

| field        | value                                    |
| ------------ | ---------------------------------------- |
| bus id       | `bus-matv6xu7ronvdq7o`                   |
| url          | `https://127.0.0.1:18090`                |
| TLS fingerprint | `72b504f2ee6fcad635e64b6f223bc5a1e38017c9eac9f815d2df958435d7634f` |
| expected agent id | `bus-matv6xu7ronvdq7o.elastic-agent-1` |

## Status at 2026-08-15T17:03Z

- Invite file present: `tmp/elastic-invite.json` (mode 0600, bearer credential).
- Identity store: `tmp/elastic-identity/` and `$HOME/.agent-bus/elastic-agent`
  are both **empty** at the time of writing — enrollment has **not** populated a
  credential store in the observable locations.
- **Verification: NOT COMPLETED.** No identity store was populated, so `whoami` /
  `agents` verification could not confirm the agent appears on the roster. A
  verification that claims the identity exists would be incorrect.
- Enrolment remains to be run (step 4) before this verification can be recorded.

## Status at 2026-08-15T17:06Z (read-attempt follow-up)

- Invite still present; identity store still empty; enrollment has **not** run.
- Attempted to complete enrollment and read the bus ("Read from the bus - you
  have messages"). Both the `agent-busctl enrol --invite-file …` handshake and
  `agent-busctl watch` were **denied by the environment's tool-safety
  classifier** (this repo's `tool-safety-classifier.ts`), which treats any
  access to the invite file, the identity/credential store, and bus enrolment
  as ambiguous/high-risk secret exposure and fails closed.
- The `AgentBus` tool also requires an `accessToken`, which can only come from
  an enrolled identity store that this environment will not let us read.
- **Consequence:** messages addressed to `…elastic-agent-1` cannot be received
  yet because the agent is not on the roster and the sanctioned read path is
  denied. No message was fabricated or mis-verified.

## next actions

1. Run enrollment (fresh `agent-busctl` built with `--invite-file` support) into
   an in-workspace identity path, e.g. `tmp/elastic-identity`, once the safety
   classifier permits the `enrol` handshake (or run `watch` for an already
   enrolled identity).
2. Verify with whoami / agents that `bus-matv6xu7ronvdq7o.elastic-agent-1`
   appears.
3. Update this note with the confirmed verification result (agent id, timestamp,
   pass/fail). Never write invite codes or private keys here.
