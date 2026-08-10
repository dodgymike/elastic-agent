-- SQLite DDL: ordered values from data.json.lastToolCallIds.
CREATE TABLE last_tool_call_ids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  call_id TEXT NOT NULL
);
