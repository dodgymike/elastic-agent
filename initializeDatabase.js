const fs = require('node:fs/promises');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const root = __dirname;
const migrationsDirectory = path.join(root, 'migrate');
const databasePath = path.join(root, 'database.sqlite');

async function readSql(filename) {
  return fs.readFile(path.join(migrationsDirectory, filename), 'utf8');
}

async function main() {
  const data = JSON.parse(await fs.readFile(path.join(root, 'data.json'), 'utf8'));

  // Rebuild from the supplied schema and source data on every invocation.
  await fs.rm(databasePath, { force: true });
  const db = await open({ filename: databasePath, driver: sqlite3.Database });

  try {
    await db.exec('PRAGMA foreign_keys = ON;');
    await db.exec(await readSql('001_request_responses.ddl.sql'));
    await db.exec(await readSql('002_tool_call_responses.ddl.sql'));
    await db.exec(await readSql('003_response_state.ddl.sql'));
    await db.exec(await readSql('004_last_tool_call_ids.ddl.sql'));

    await db.exec('BEGIN IMMEDIATE;');
    try {
      // Load each source collection in its JSON-array/object insertion order.
      const insertResponse = await db.prepare(
        'INSERT INTO request_responses (position, response_json) VALUES (?, json(?))',
      );
      for (const [position, response] of (data.requestResponses ?? []).entries()) {
        await insertResponse.run(position, JSON.stringify(response));
      }
      await insertResponse.finalize();

      const insertCall = await db.prepare(
        'INSERT INTO tool_call_responses (call_id, tool_arguments_json, tool_response_json) VALUES (?, json(?), json(?))',
      );
      for (const [callId, value] of Object.entries(data.toolCallResponse ?? {})) {
        await insertCall.run(callId, JSON.stringify(value.toolArguments), JSON.stringify(value.toolResponse));
      }
      await insertCall.finalize();

      await db.run(
        'INSERT INTO response_state (id, last_response_id) VALUES (1, ?)',
        data.lastResponseId ?? null,
      );

      const insertLastCall = await db.prepare(
        'INSERT INTO last_tool_call_ids (position, call_id) VALUES (?, ?)',
      );
      for (const [position, callId] of (data.lastToolCallIds ?? []).entries()) {
        await insertLastCall.run(position, callId);
      }
      await insertLastCall.finalize();
      await db.exec('COMMIT;');
    } catch (error) {
      await db.exec('ROLLBACK;');
      throw error;
    }
  } finally {
    await db.close();
  }

  console.log(`Created and populated ${databasePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
