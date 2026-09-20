/** Version constants — DESIGN_SPECIFICATION §2.1/§2.3. */

/** Storage schema version owned by repositories (migrations are sequential). */
export const SCHEMA_VERSION = 1;

/** Metric formula version; changes must not rewrite historical interpretation (§4.5). */
export const METRIC_VERSION = 1;

/** Curriculum asset version (§5.2). */
export const CURRICULUM_VERSION = 'ff-curriculum-v1';

/** Dictionary content version (§5.3). */
export const DICTIONARY_VERSION = 'ff-english-10k-v1';

/** Custom-text normalization policy version (§5.4). */
export const NORMALIZATION_VERSION = 1;

/** Backup envelope format version (§2.1). */
export const BACKUP_FORMAT_VERSION = 1;

/** App build identity stamped into records/exports (never used to block downgrades). */
export const APP_BUILD = 'dev';

/** Content versions map recorded in BackupEnvelope.contentVersions. */
export const CONTENT_VERSIONS: Record<string, string> = {
  curriculum: CURRICULUM_VERSION,
  dictionary: DICTIONARY_VERSION,
  soundPacks: 'ff-sounds-v1',
};
