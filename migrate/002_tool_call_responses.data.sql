-- Load directly from the supplied data.json. Run with the sqlite3 CLI, whose
-- readfile() SQL function reads the file as UTF-8 text.
BEGIN;
WITH source(doc) AS (SELECT CAST(readfile('data.json') AS TEXT)),
ordered(id, call_id) AS (
  VALUES
    (1, 'call_3iFIt7D1n5s1gVqP83TcaK1I'),
    (2, 'call_m7RE8FaIclCMROlavYPg1wA1'),
    (3, 'call_J3TaT3DDDcSP17Rvz7EypYZh'),
    (4, 'call_znGM6wvjNhRpCv6JsaZs573r'),
    (5, 'call_Pb3Kvc3bY2dotucWW4I6iG1j'),
    (6, 'call_aNBtOXCD9BMG3kyi2qinBwSb'),
    (7, 'call_cgvjiNekpPc1153MoR6P0wUE'),
    (8, 'call_1ebilAtSOlYD5iTdvdSlE6mD'),
    (9, 'call_JJ4XP7QqMIQZFgS7TeTbumPk'),
    (10, 'call_BnU2rrxb19f6JWlX5O5KPwbO'),
    (11, 'call_57iHzI2Kg7K1HgWPxibaKcKy')
)
INSERT INTO tool_call_responses (id, call_id, tool_arguments_json, tool_response_json)
SELECT ordered.id,
       ordered.call_id,
       json_extract(source.doc, '$.toolCallResponse."' || ordered.call_id || '".toolArguments'),
       json_extract(source.doc, '$.toolCallResponse."' || ordered.call_id || '".toolResponse')
FROM ordered CROSS JOIN source
ORDER BY ordered.id;
COMMIT;
