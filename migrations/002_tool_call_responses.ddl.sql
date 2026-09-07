-- SQLite DDL: records each property of data.json.toolCallResponse.
CREATE TABLE tool_call_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL UNIQUE,
  tool_arguments_json TEXT NOT NULL CHECK (json_valid(tool_arguments_json)),
  tool_response_json TEXT NOT NULL CHECK (json_valid(tool_response_json))
);
