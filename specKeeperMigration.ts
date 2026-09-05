import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  canonicalizeSpecKeeperStartDirectory,
  loadSpecKeeperDefaultsFile,
  redactUrlCredentialsForLogging,
  removeSpecKeeperWorkspaceConfigEntry,
  specKeeperWorkspaceConfigPath,
  SPEC_KEEPER_WORKSPACE_DIR,
  upsertSpecKeeperWorkspaceConfig,
  writeSpecKeeperCredentialFile,
  type SpecKeeperWorkspaceConfig,
} from "./specKeeperConfig.js";

/**
 * Migrate the legacy single-file Spec Keeper layout into the workspace layout:
 *
 *   legacy `.spec-keeper` (file)      -> `.spec-keeper/config` (non-secret
 *                                        shared workspace mapping, written
 *                                        under the main.ts directory unless a
 *                                        configDirectory override is supplied)
 *                                        and, when a legacy credential store
 *                                        exists, a new
 *                                        `.spec-keeper/<project-slug>.json`
 *                                        credential file under the workspace
 *                                        start directory with owner-only mode.
 *   legacy `.spec.local.json` (etc.)  -> copied to
 *                                        `.spec-keeper/<project-slug>.json`
 *                                        with mode `0600`; the legacy store is
 *                                        left in place and, on POSIX, tightened
 *                                        to mode `0600` as well.
 *
 * The legacy `.spec-keeper` file is renamed aside while the new directory is
 * written and is restored if any write fails, so a failed migration never
 * deletes the legacy config. A half-written shared registry entry is removed
 * on rollback. The migration reads only the metadata it needs and never prints
 * credential values.
 */

const LEGACY_CONFIG_FILE = ".spec-keeper";
const LEGACY_CREDENTIAL_STORE_DEFAULT = ".spec.local.json";
const BUILTIN_PROJECT_SLUG = "elastic-agent";
const BUILTIN_API_BASE = "https://api.spec.elasticninja.com";
const PROJECT_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LEGACY_CONFIG_BACKUP_SUFFIX = ".legacy.migrating";

/** Secret-free migration report. Paths and modes only; never credential values. */
export interface SpecKeeperMigrationReport {
  /** Canonical absolute start directory that was migrated. */
  startDirectory: string;
  /** True when the legacy `.spec-keeper` file was migrated. */
  migrated: boolean;
  /** Resolved project slug written to `.spec-keeper/config`. */
  projectSlug?: string;
  /** Resolved API base written to `.spec-keeper/config`. */
  apiBase?: string;
  /** Absolute path of the updated `.spec-keeper/config`. */
  configPath?: string;
  /** Absolute path of the new credential file, when a legacy store was copied. */
  credentialFile?: string;
  /** Absolute path of the legacy `.spec-keeper` config file. */
  legacyConfigPath: string;
  /** Absolute path of the legacy credential store, when one was found. */
  legacyCredentialPath?: string;
  /** Legacy credential store mode before migration (octal string). */
  legacyCredentialModeBefore?: string;
  /** Legacy credential store mode after migration (octal string). */
  legacyCredentialModeAfter?: string;
  warnings: string[];
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (!(key in record)) continue;
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

function resolveLegacyCredentialPath(
  startDirectory: string,
  credentialStore: string | undefined,
): string {
  const value = credentialStore?.trim() || LEGACY_CREDENTIAL_STORE_DEFAULT;
  return isAbsolute(value) ? value : resolve(startDirectory, value);
}

/** One-line, secret-safe summary of a migration report. */
export function describeSpecKeeperMigrationReport(
  report: SpecKeeperMigrationReport,
): string {
  if (!report.migrated) {
    const details = report.warnings.length
      ? `\n${report.warnings.map((warning) => `  - ${warning}`).join("\n")}`
      : "";
    return `Spec Keeper migration: no changes for ${report.startDirectory}.${details}`;
  }

  const lines = [
    `Spec Keeper migration completed for ${report.startDirectory}:`,
    `  projectSlug=${report.projectSlug ?? "(none)"}`,
    `  apiBase=${redactUrlCredentialsForLogging(report.apiBase ?? "")}`,
    `  configPath=${report.configPath ?? "(none)"}`,
  ];
  if (report.credentialFile) {
    lines.push(`  credentialFile=${report.credentialFile} (mode 0600)`);
  }
  lines.push(`  legacyConfigPath=${report.legacyConfigPath} (removed)`);
  if (report.legacyCredentialPath) {
    lines.push(
      `  legacyCredentialPath=${report.legacyCredentialPath} (mode ${report.legacyCredentialModeBefore ?? "?"} -> ${report.legacyCredentialModeAfter ?? "?"})`,
    );
  }
  if (report.warnings.length > 0) {
    lines.push(
      `  warnings:\n${report.warnings.map((warning) => `    - ${warning}`).join("\n")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Migrate one workspace from the legacy `.spec-keeper` file layout to the new
 * `.spec-keeper/` directory layout. This is intentionally synchronous and
 * fail-closed: malformed config or credential stores abort the migration with
 * an actionable error rather than guessing.
 */
export function migrateSpecKeeperWorkspace(
  startDirectory?: string,
  options?: { configDirectory?: string },
): SpecKeeperMigrationReport {
  const canonicalStart = canonicalizeSpecKeeperStartDirectory(
    startDirectory ?? process.cwd(),
  );
  if (
    options?.configDirectory !== undefined &&
    typeof options.configDirectory !== "string"
  ) {
    throw new TypeError("configDirectory must be a string path.");
  }
  // The `.spec-keeper/config` registry is shared and lives under the main.ts
  // directory by default (or an explicit configDirectory override), while the
  // migrated credential file stays under the workspace start directory.
  const configDirectory = options?.configDirectory?.trim()
    ? resolve(options.configDirectory.trim())
    : undefined;
  const legacyConfigPath = join(canonicalStart, LEGACY_CONFIG_FILE);
  const warnings: string[] = [];

  let legacyStats;
  try {
    legacyStats = statSync(legacyConfigPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        startDirectory: canonicalStart,
        migrated: false,
        legacyConfigPath,
        warnings: [
          `No legacy .spec-keeper file found at ${legacyConfigPath}; nothing to migrate.`,
        ],
      };
    }
    throw new Error(
      `Spec Keeper migration could not inspect '${legacyConfigPath}'.`,
      { cause: error },
    );
  }

  if (legacyStats.isDirectory()) {
    return {
      startDirectory: canonicalStart,
      migrated: false,
      legacyConfigPath,
      warnings: [
        `${legacyConfigPath} is already a directory; no legacy file to migrate.`,
      ],
    };
  }

  // Parse the legacy config through the shared loader, but fail closed when the
  // file itself is malformed or not a JSON object.
  const legacy = loadSpecKeeperDefaultsFile({ cwd: canonicalStart, env: {} });
  if (legacy.source === "missing") {
    return {
      startDirectory: canonicalStart,
      migrated: false,
      legacyConfigPath,
      warnings: [`No legacy .spec-keeper file was readable at ${legacyConfigPath}.`],
    };
  }
  if (legacy.warnings.some((warning) => /\.spec-keeper is invalid/.test(warning))) {
    throw new Error(
      `Spec Keeper migration cannot migrate '${legacyConfigPath}': ${legacy.warnings.join(" ")}`,
    );
  }
  warnings.push(...legacy.warnings);

  const config = legacy.config;
  const legacyCredentialPath = resolveLegacyCredentialPath(
    canonicalStart,
    config.credentialStore,
  );

  let credentialRecord: Record<string, unknown> | undefined;
  let legacyCredentialModeBefore: string | undefined;
  let legacyCredentialExists = false;
  try {
    legacyCredentialModeBefore = modeString(statSync(legacyCredentialPath).mode);
    legacyCredentialExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Spec Keeper migration could not inspect the legacy credential store '${legacyCredentialPath}'.`,
        { cause: error },
      );
    }
  }

  if (legacyCredentialExists) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(legacyCredentialPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Spec Keeper migration could not read the legacy credential store '${legacyCredentialPath}' as JSON.`,
        { cause: error },
      );
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        "Spec Keeper migration cannot migrate the legacy credential store; the top-level value must be a JSON object.",
      );
    }
    credentialRecord = raw as Record<string, unknown>;
  } else {
    warnings.push(
      `No legacy credential store found at ${legacyCredentialPath}; the workspace mapping will point at the future .spec-keeper credential file.`,
    );
  }

  const configProjectSlug = config.projectSlug?.trim();
  const credentialProjectSlug = credentialRecord
    ? readString(credentialRecord, ["projectSlug", "project_slug", "Project", "project"])
    : undefined;
  const projectSlug = (configProjectSlug || credentialProjectSlug || BUILTIN_PROJECT_SLUG).trim();
  if (!PROJECT_SLUG_PATTERN.test(projectSlug)) {
    throw new Error(
      "Spec Keeper migration needs a URL-safe project slug; the legacy config and credential store did not supply one.",
    );
  }
  if (!configProjectSlug && !credentialProjectSlug) {
    warnings.push(
      `No projectSlug found in the legacy config or credential store; falling back to built-in '${BUILTIN_PROJECT_SLUG}'.`,
    );
  }

  const configApiBase = config.apiBase?.trim();
  const credentialApiBase = credentialRecord
    ? readString(credentialRecord, ["apiBase", "api_base", "API base", "API Base"])
    : undefined;
  const apiBase = (configApiBase || credentialApiBase || BUILTIN_API_BASE).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(apiBase)) {
    throw new Error(
      "Spec Keeper migration could not resolve a valid http(s) apiBase from the legacy config or credential store.",
    );
  }

  let newCredentialRecord: Record<string, unknown> | undefined;
  if (credentialRecord) {
    newCredentialRecord = { ...credentialRecord };
    if (readString(newCredentialRecord, ["projectSlug", "project_slug", "Project", "project"]) === undefined) {
      newCredentialRecord.project_slug = projectSlug;
    }
    if (readString(newCredentialRecord, ["apiBase", "api_base", "API base", "API Base"]) === undefined) {
      newCredentialRecord.api_base = apiBase;
    }
  }

  const specDir = join(canonicalStart, SPEC_KEEPER_WORKSPACE_DIR);
  const backupPath = `${legacyConfigPath}${LEGACY_CONFIG_BACKUP_SUFFIX}`;
  try {
    renameSync(legacyConfigPath, backupPath);
  } catch (error) {
    throw new Error(
      `Spec Keeper migration could not move the legacy config out of the way: '${legacyConfigPath}'.`,
      { cause: error },
    );
  }

  const credentialFileRelative = join(SPEC_KEEPER_WORKSPACE_DIR, `${projectSlug}.json`);
  const credentialFile = join(canonicalStart, credentialFileRelative);
  const configPath = specKeeperWorkspaceConfigPath(configDirectory);
  let configUpserted = false;
  try {
    mkdirSync(specDir, { recursive: true, mode: 0o700 });

    if (newCredentialRecord) {
      writeSpecKeeperCredentialFile(credentialFile, newCredentialRecord);
    }

    const entry: SpecKeeperWorkspaceConfig = {
      projectSlug,
      credentialFile: credentialFileRelative,
    };
    if (configApiBase || credentialApiBase) entry.apiBase = apiBase;
    if (config.defaultEpic) entry.defaultEpic = config.defaultEpic;
    if (config.defaultTask) entry.defaultTask = config.defaultTask;
    upsertSpecKeeperWorkspaceConfig(configPath, canonicalStart, entry);
    configUpserted = true;

    let legacyCredentialModeAfter = legacyCredentialModeBefore;
    if (legacyCredentialExists && process.platform !== "win32") {
      chmodSync(legacyCredentialPath, 0o600);
      legacyCredentialModeAfter = modeString(statSync(legacyCredentialPath).mode);
    }

    unlinkSync(backupPath);

    return {
      startDirectory: canonicalStart,
      migrated: true,
      projectSlug,
      apiBase,
      configPath,
      credentialFile: newCredentialRecord ? credentialFile : undefined,
      legacyConfigPath,
      legacyCredentialPath: legacyCredentialExists ? legacyCredentialPath : undefined,
      legacyCredentialModeBefore,
      legacyCredentialModeAfter,
      warnings,
    };
  } catch (error) {
    // Roll back the shared registry entry and the workspace credential
    // directory, then restore the legacy config so a failed migration never
    // deletes the legacy config or leaves a half-written mapping behind.
    if (configUpserted) {
      try {
        removeSpecKeeperWorkspaceConfigEntry(configPath, canonicalStart);
      } catch {
        // Preserve the original migration error.
      }
    }
    try {
      rmSync(specDir, { recursive: true, force: true });
    } catch {
      // Preserve the original migration error.
    }
    try {
      if (existsSync(backupPath)) renameSync(backupPath, legacyConfigPath);
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  }
}
