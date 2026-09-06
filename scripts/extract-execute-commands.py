#!/usr/bin/env python3
"""Stream llm.log response sections and group ExecuteCommand requests."""
import argparse
from collections import Counter
import json
import sys


def extract(stream):
    groups = {}
    responses = malformed_responses = invalid_calls = 0
    lines = None
    for line in stream:
        marker = line.rstrip("\r\n")
        if marker == "--- RESPONSE ---":
            if lines is not None:
                malformed_responses += 1
            lines = []
        elif marker == "--- USAGE ---" and lines is not None:
            responses += 1
            try:
                response = json.loads("".join(lines))
            except (ValueError, TypeError):
                malformed_responses += 1
                lines = None
                continue
            lines = None
            if not isinstance(response, dict):
                malformed_responses += 1
                continue
            calls = response.get("toolCalls", response.get("tool_calls", []))
            if not isinstance(calls, list):
                malformed_responses += 1
                continue
            for call in calls:
                if not isinstance(call, dict):
                    continue
                function = call.get("function", call)
                if not isinstance(function, dict) or function.get("name") != "ExecuteCommand":
                    continue
                args = function.get("arguments")
                try:
                    if isinstance(args, str):
                        args = json.loads(args)
                    if not isinstance(args, dict) or not isinstance(args.get("command"), str):
                        raise ValueError("missing command")
                    parameters = args.get("parameters", [])
                    if not isinstance(parameters, list) or not all(isinstance(p, str) for p in parameters):
                        raise ValueError("invalid parameters")
                except (ValueError, TypeError):
                    invalid_calls += 1
                    continue
                groups.setdefault(args["command"], Counter())[tuple(parameters)] += 1
        elif lines is not None:
            lines.append(line)
    if lines is not None:
        malformed_responses += 1
    commands = [
        {"command": command, "count": sum(variants.values()),
         "parameter_variants": [{"parameters": list(parameters), "count": count}
                                for parameters, count in sorted(variants.items(), key=lambda item: (-item[1], item[0]))]}
        for command, variants in groups.items()
    ]
    commands.sort(key=lambda group: (-group["count"], group["command"]))
    return {"total_calls": sum(group["count"] for group in commands),
            "unique_commands": len(commands), "response_sections": responses,
            "malformed_response_sections": malformed_responses,
            "invalid_execute_command_calls": invalid_calls, "commands": commands}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", nargs="?", default="llm.log", help="input log path (default: llm.log)")
    args = parser.parse_args()
    try:
        with open(args.log, encoding="utf-8") as stream:
            report = extract(stream)
        json.dump(report, sys.stdout, indent=2, ensure_ascii=True)
        print()
        if report["malformed_response_sections"] or report["invalid_execute_command_calls"]:
            print("Warning: incomplete or malformed entries were skipped; see report counters.", file=sys.stderr)
    except (OSError, UnicodeError) as error:
        print(f"Cannot extract commands: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
