import {
  describeSpecKeeperMigrationReport,
  migrateSpecKeeperWorkspace,
} from "./specKeeperMigration.js";

/**
 * Minimal CLI for migrating one workspace from the legacy `.spec-keeper` file
 * layout to the new `.spec-keeper/` directory layout. Prints only the
 * secret-free migration report; credential values are never printed.
 *
 * Usage: node dist/specKeeperMigrateCli.js [startDirectory]
 */
const startDirectory = process.argv[2]?.trim() || process.cwd();
try {
  const report = migrateSpecKeeperWorkspace(startDirectory);
  console.log(describeSpecKeeperMigrationReport(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
