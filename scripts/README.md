# Log analysis

Extract `ExecuteCommand` requests from the default `llm.log`:

```sh
python3 scripts/extract-execute-commands.py > /tmp/execute-command-groups.json
```

Pass a different log path as the positional argument. Requires Python 3 and no
third-party packages. JSON output groups by the exact command string, sorted by
count descending, with counts for each positional-parameter variant. Whitespace
and quoting are preserved; shell source is never executed or normalized.

Only response sections are counted, so calls repeated in prompt history are
excluded. Counts represent model requests, including requests subsequently
refused or failed; they do not prove successful execution. The script handles
normalized `toolCalls` and OpenAI-style `tool_calls` with JSON-string arguments.
Malformed calls and incomplete response sections are skipped and counted in the
report, with a warning on stderr. Missing/unreadable inputs exit nonzero.

Input is streamed one response section at a time. Memory use depends on the
largest response and number of unique commands/parameter variants, rather than
the whole log. Reports contain the original command arguments; keep generated
reports outside the repository. For a consistent report, use a log that is no
longer being written.

Run focused tests:

```sh
python3 -B test/extract-execute-commands.test.py
```
