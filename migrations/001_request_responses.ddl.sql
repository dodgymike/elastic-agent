-- SQLite DDL: records entries from data.json.requestResponses.
CREATE TABLE request_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  response_json TEXT NOT NULL CHECK (json_valid(response_json))
);
