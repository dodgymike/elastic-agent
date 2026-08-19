// Schema-vs-handler consistency test.
//
// Each native tool now co-locates its advertised `parameters` schema next to
// its handler (for example `ReadParameters` in tools/Read.ts and `GitParameters`
// in tools/Git.tsx), and main.ts wires those same schema objects into the
// native tool definitions the model sees. This test guards the two schema facts
// that previously drifted from the handlers, so a future edit cannot silently
// un-advertise a parameter/action the handler still accepts:
//
//   - the Read schema must advertise `read_hash` (the handler validates an
//     optional expected SHA-256);
//   - the Git schema's `action` enum must include the legacy `list` value (the
//     handler retains the backward-compatible `action === "list"` branch that
//     docs and git-tool.test.ts rely on).
//
// Handler *behavior* is already covered by test/read-tool.test.ts and
// test/git-tool.test.ts; this file only asserts that the advertised schema
// remains consistent with those handlers.
// Compiled and executed standalone by the `test:tool-schema` npm script.
import { ReadParameters } from "../tools/Read.js";
import { GitParameters } from "../tools/Git.js";
import { GrepParameters } from "../tools/Grep.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function propertiesOf(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = asRecord(parameters.properties);
  return properties as Record<string, unknown>;
}

function main(): void {
  // ---------------------------------------------------------------------------
  // 1. The Read schema advertises exactly the parameters the handler accepts.
  // ---------------------------------------------------------------------------
  check("Read schema root declares an object", asRecord(ReadParameters).type === "object");

  const readProperties = propertiesOf(ReadParameters as Record<string, unknown>);
  check(
    "Read schema advertises read_hash as a string",
    typeof readProperties.read_hash === "object" &&
      asRecord(readProperties.read_hash).type === "string",
  );

  // Every schema-declared property is a real ReadOption key. (These are the
  // only parameters the tools/Read.ts handler inspects.)
  const expectedReadParams = ["path", "file_size", "read_length", "read_offset", "line_range", "read_hash"];
  const readKeys = Object.keys(readProperties).sort();
  check(
    `Read schema property set matches the handler options (${expectedReadParams.join(", ")})`,
    JSON.stringify(readKeys) === JSON.stringify([...expectedReadParams].sort()),
  );
  check(
    "Read schema requires file_size, read_offset, and read_length (handler prerequisites)",
    JSON.stringify((ReadParameters as { required?: string[] }).required?.sort()) ===
      JSON.stringify(["file_size", "read_length", "read_offset", "path"].sort()),
  );

  // ---------------------------------------------------------------------------
  // 2. The Git schema's action enum includes the retained legacy `list` alias
  //    and the mode enum matches the handler's read-only modes.
  // ---------------------------------------------------------------------------
  check("Git schema root declares an object", asRecord(GitParameters).type === "object");

  const gitProperties = propertiesOf(GitParameters as Record<string, unknown>);
  const actionSchema = asRecord(gitProperties.action);
  check("Git schema declares an action property", actionSchema.type === "string");
  check(
    "Git action enum includes the legacy 'list' alias",
    Array.isArray(actionSchema.enum) && actionSchema.enum.includes("list"),
  );
  check(
    "Git action enum lists exactly list/stage/commit",
    JSON.stringify((actionSchema.enum as string[]).sort()) ===
      JSON.stringify(["commit", "list", "stage"].sort()),
  );

  const modeSchema = asRecord(gitProperties.mode);
  check(
    "Git mode enum matches the handler read-only modes",
    JSON.stringify(((modeSchema.enum as string[]) ?? []).sort()) ===
      JSON.stringify(["diff", "log", "ls-files", "status"].sort()),
  );

  // The anyOf constraint requires one of mode/action, mirroring the handler's
  // branched dispatch (isModeOptions vs the action switch).
  const anyOf = (GitParameters as { anyOf?: unknown[] }).anyOf;
  check(
    "Git schema declares an anyOf (mode XOR action) constraint",
    Array.isArray(anyOf) && anyOf.length === 2,
  );

  // ---------------------------------------------------------------------------
  // 3. The Grep schema advertises exactly the options the handler accepts.
  //    GrepParameters co-locates the schema next to Grep in tools/Grep.ts and
  //    is wired into main.ts, so the advertised parameter set and required
  //    fields must stay consistent with the handler's GrepOptions.
  // ---------------------------------------------------------------------------
  check("Grep schema root declares an object", asRecord(GrepParameters).type === "object");
  const grepProperties = propertiesOf(GrepParameters as Record<string, unknown>);
  const expectedGrepParams = [
    "pattern",
    "path",
    "name",
    "recursive",
    "literal",
    "maxdepth",
    "ignoreCase",
    "maxFileSize",
    "limit",
  ];
  check(
    `Grep schema property set matches the handler options (${expectedGrepParams.join(", ")})`,
    JSON.stringify(Object.keys(grepProperties).sort()) === JSON.stringify([...expectedGrepParams].sort()),
  );
  check(
    "Grep schema requires pattern and path (handler prerequisites)",
    JSON.stringify((GrepParameters as { required?: string[] }).required?.sort()) ===
      JSON.stringify(["path", "pattern"].sort()),
  );

  if (failures === 0) {
    console.log("\nAll schema-vs-handler consistency checks passed.");
    process.exit(0);
  } else {
    console.error(`\n${failures} schema-vs-handler consistency check(s) failed.`);
    process.exit(1);
  }
}

main();
