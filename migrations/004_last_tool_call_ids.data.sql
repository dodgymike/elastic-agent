-- Load directly from the supplied data.json with the sqlite3 CLI.
BEGIN;
WITH source(doc) AS (SELECT CAST(readfile('data.json') AS TEXT))
INSERT INTO last_tool_call_ids (id, position, call_id)
SELECT CAST(item.key AS INTEGER) + 1,
       CAST(item.key AS INTEGER),
       item.value
FROM source, json_each(source.doc, '$.lastToolCallIds') AS item
ORDER BY CAST(item.key AS INTEGER);
COMMIT;
