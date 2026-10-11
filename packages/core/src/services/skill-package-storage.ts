// Compatibility exports keep existing Skill package consumers on the shared adapter.
export {
  LocalStorageAdapter as LocalSkillPackageStorageAdapter,
  sha256Hex, normalizeObjectKey,
  type StorageBody as SkillPackageStorageBody,
  type StorageObjectMetadata as SkillPackageStorageObjectMetadata,
  type PutStorageObjectInput as PutSkillPackageStorageObjectInput,
  type GetStorageObjectResult as GetSkillPackageStorageObjectResult,
  type StorageAdapter as SkillPackageStorageAdapter,
  type LocalStorageOptions as LocalSkillPackageStorageOptions,
} from "./local-storage";
