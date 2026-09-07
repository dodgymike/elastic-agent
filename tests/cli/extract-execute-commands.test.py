import importlib.util
import io
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("extractor", Path(__file__).resolve().parents[2] / "scripts/extract-execute-commands.py")
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


def record(response):
    return "--- PROMPT ---\n" + json.dumps(response) + "\n--- RESPONSE ---\n" + json.dumps(response, indent=2) + "\n--- USAGE ---\n{}\n"


class ExtractionTests(unittest.TestCase):
    def test_groups_calls_without_counting_prompt_history(self):
        call = {"name": "ExecuteCommand", "arguments": {"command": 'printf "%s" "$1"', "parameters": ["a\nb"]}}
        response = {"toolCalls": [call, call, {"name": "Read", "arguments": {"path": "x"}}]}
        other = {"tool_calls": [{"function": {"name": "ExecuteCommand", "arguments": json.dumps({"command": call["arguments"]["command"], "parameters": ["c"]})}}]}
        report = extractor.extract(io.StringIO(record(response) + record(other)))
        self.assertEqual(report["total_calls"], 3)
        self.assertEqual(report["unique_commands"], 1)
        self.assertEqual(report["commands"][0]["parameter_variants"], [{"parameters": ["a\nb"], "count": 2}, {"parameters": ["c"], "count": 1}])

    def test_malformed_and_truncated_entries_are_reported(self):
        text = "--- RESPONSE ---\ninvalid\n--- USAGE ---\n"
        text += record({"toolCalls": [{"name": "ExecuteCommand", "arguments": "broken"}]})
        text += record({"toolCalls": [{"name": "ExecuteCommand", "arguments": {"command": "pwd"}}]})
        text += "--- RESPONSE ---\n{"
        report = extractor.extract(io.StringIO(text))
        self.assertEqual(report["malformed_response_sections"], 2)
        self.assertEqual(report["invalid_execute_command_calls"], 1)
        self.assertEqual(report["total_calls"], 1)


if __name__ == "__main__":
    unittest.main()
