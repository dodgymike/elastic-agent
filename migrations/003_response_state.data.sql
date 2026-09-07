-- Load directly from the supplied data.json with the sqlite3 CLI.
BEGIN;
INSERT INTO response_state (id, last_response_id)
SELECT 1, json_extract(CAST(readfile('data.json') AS TEXT), '$.lastResponseId');
COMMIT;
