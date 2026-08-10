/**
 * Repository functions for the SQLite schema in 00*_*.sql.
 *
 * All collection reads include an explicit ORDER BY. Do not remove these
 * clauses: SQLite does not otherwise promise insertion, primary-key, or JSON
 * array order.
 */
export interface SqliteStatement {
  run(...parameters: readonly unknown[]): unknown;
  get<T = unknown>(...parameters: readonly unknown[]): T | undefined;
  all<T = unknown>(...parameters: readonly unknown[]): T[];
}
export interface SqliteDatabase { prepare(sql: string): SqliteStatement; }

export interface RequestResponseRow { id: number; position: number; response_json: string; }
export interface ToolCallResponseRow {
  id: number; call_id: string; tool_arguments_json: string; tool_response_json: string;
}
export interface ResponseStateRow { id: number; last_response_id: string | null; }
export interface LastToolCallIdRow { id: number; position: number; call_id: string; }

/** Reads request responses in their original JSON-array order. */
export function readRequestResponses(db: SqliteDatabase): RequestResponseRow[] {
  return db.prepare('SELECT id, position, response_json FROM request_responses ORDER BY position ASC, id ASC').all<RequestResponseRow>();
}
/** Replaces the ordered request-response collection. */
export function writeRequestResponses(db: SqliteDatabase, responses: readonly unknown[]): void {
  db.prepare('DELETE FROM request_responses').run();
  const insert = db.prepare('INSERT INTO request_responses (position, response_json) VALUES (?, json(?))');
  responses.forEach((response, position) => insert.run(position, JSON.stringify(response)));
}
/** Appends an item after the current final request-response position. */
export function appendRequestResponse(db: SqliteDatabase, response: unknown): unknown {
  return db.prepare("INSERT INTO request_responses (position, response_json) VALUES (COALESCE((SELECT MAX(position) + 1 FROM request_responses), 0), json(?))").run(JSON.stringify(response));
}

/** Reads tool calls in the assigned sequential-id order. */
export function readToolCallResponses(db: SqliteDatabase): ToolCallResponseRow[] {
  return db.prepare('SELECT id, call_id, tool_arguments_json, tool_response_json FROM tool_call_responses ORDER BY id ASC').all<ToolCallResponseRow>();
}
export function readToolCallResponse(db: SqliteDatabase, callId: string): ToolCallResponseRow | undefined {
  return db.prepare('SELECT id, call_id, tool_arguments_json, tool_response_json FROM tool_call_responses WHERE call_id = ? ORDER BY id ASC LIMIT 1').get<ToolCallResponseRow>(callId);
}
/** Inserts or updates a call without changing the sequential id of an existing call. */
export function writeToolCallResponse(db: SqliteDatabase, callId: string, toolArguments: unknown, toolResponse: unknown): unknown {
  return db.prepare('INSERT INTO tool_call_responses (call_id, tool_arguments_json, tool_response_json) VALUES (?, json(?), json(?)) ON CONFLICT(call_id) DO UPDATE SET tool_arguments_json = excluded.tool_arguments_json, tool_response_json = excluded.tool_response_json').run(callId, JSON.stringify(toolArguments), JSON.stringify(toolResponse));
}
/** Appends a new call. id is assigned by SQLite AUTOINCREMENT. */
export function appendToolCallResponse(db: SqliteDatabase, callId: string, toolArguments: unknown, toolResponse: unknown): unknown {
  return db.prepare('INSERT INTO tool_call_responses (call_id, tool_arguments_json, tool_response_json) VALUES (?, json(?), json(?))').run(callId, JSON.stringify(toolArguments), JSON.stringify(toolResponse));
}

/** Reads the one current checkpoint deterministically. */
export function readResponseState(db: SqliteDatabase): ResponseStateRow | undefined {
  return db.prepare('SELECT id, last_response_id FROM response_state ORDER BY id ASC LIMIT 1').get<ResponseStateRow>();
}
/** Writes the current checkpoint; preserves the first sequential state id. */
export function writeResponseState(db: SqliteDatabase, lastResponseId: string | null): unknown {
  return db.prepare('INSERT INTO response_state (id, last_response_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_response_id = excluded.last_response_id').run(lastResponseId);
}

/** Reads pending tool-call IDs in their source-array order. */
export function readLastToolCallIds(db: SqliteDatabase): LastToolCallIdRow[] {
  return db.prepare('SELECT id, position, call_id FROM last_tool_call_ids ORDER BY position ASC, id ASC').all<LastToolCallIdRow>();
}
/** Appends a pending ID at the end of the ordered list. */
export function appendLastToolCallId(db: SqliteDatabase, callId: string): unknown {
  return db.prepare("INSERT INTO last_tool_call_ids (position, call_id) VALUES (COALESCE((SELECT MAX(position) + 1 FROM last_tool_call_ids), 0), ?)").run(callId);
}
/** Replaces the ordered pending-ID list. Newly inserted rows receive sequential ids. */
export function writeLastToolCallIds(db: SqliteDatabase, callIds: readonly string[]): void {
  db.prepare('DELETE FROM last_tool_call_ids').run();
  const insert = db.prepare('INSERT INTO last_tool_call_ids (position, call_id) VALUES (?, ?)');
  callIds.forEach((callId, position) => insert.run(position, callId));
}
