-- SQLite DDL: the latest response checkpoint from data.json.
CREATE TABLE response_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  last_response_id TEXT
);
