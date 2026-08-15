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

## next actions

1. Run enrollment (fresh `agent-busctl` built with `--invite-file` support) into
   an in-workspace identity path, e.g. `tmp/elastic-identity`.
2. Verify with whoami / agents that `bus-matv6xu7ronvdq7o.elastic-agent-1`
   appears.
3. Update this note with the confirmed verification result (agent id, timestamp,
   pass/fail). Never write invite codes or private keys here.
