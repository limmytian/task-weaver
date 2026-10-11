# Attachment documents

Attachments supplement Markdown documents with one original file, a title,
description and tags. Document form cannot be changed in place. Project and
personal ownership, permissions and document/requirement/task links apply to
current and historical files. Metadata edits increment the document version but
do not copy file bytes. Replacement requires the current document version and
appends an immutable file version. Earlier files remain downloadable until the
document is permanently deleted.

## Storage and deployment

PostgreSQL contains metadata and version pointers; original bytes live in local
storage. Set `TW_ATTACHMENT_STORAGE_DIR` to an absolute persistent mounted path
in **both API and Web**. Both processes must see the same files because Web route
handlers use the same authenticated attachment service. The development default
is `.task-weaver/attachments` relative to the process working directory. Do not
serve this directory through a static web server or commit it to source control.
`TW_ATTACHMENT_MAX_BYTES` defaults to `52428800` (50 MiB); configure the same
positive integer on both processes. Limits are enforced while streaming bytes.
Match proxy request limits/timeouts to the configured upload policy.

The Compose template mounts the `attachment-data` named volume at
`/app/attachment-data` in API and Web. Container build recipes create the mount
point writable by the runtime user. Existing volumes must also be writable by
UID/GID 1000. Preserve this volume when recreating services; `down --volumes`
deletes it. Image references remain pinned to their existing published release;
source changes do not authorize publication or deployment.

The Kubernetes templates use a separate ReadWriteOnce attachment PVC and
co-locate the single Web replica with the API on one node. `fsGroup: 1000`
provides runtime access when supported by the storage driver. This is a single
node local-filesystem topology. Multi-node/multi-replica installations require a
filesystem with compatible shared read/write semantics and a reviewed scheduling
and permission configuration. Object storage is outside this version's scope.

Uploads stream to a temporary object, check the limit/checksum, then rename
before publishing a transactional database version. Failed requests and losing
concurrent replacements remove their objects. Object keys are server-generated;
original filenames are display/download metadata, never filesystem paths.

## Interfaces

The Web document creation dialog selects Markdown or attachment. Attachment
details expose metadata editing, original download, replacement and file history.
PDF previews render pages to a canvas with locally bundled PDF.js assets and
page navigation; PDF scripting and interactive actions are not executed. Safe
raster images and plain text have protected previews; every preview
retains a download fallback. HTML, SVG, Office and other unsupported formats are
download-only. Preview responses use sandboxing, no sniffing and no caching.

```sh
tw doc upload ./material.pdf --project <project-id> --title "Supplemental material" --mime-type application/pdf
tw doc get <document-id> --json
tw doc files <document-id> --json
tw doc update <document-id> --summary "Revised description" --tags supplemental --expected-version <document-version>
tw doc replace-file <document-id> ./updated.pdf --expected-version <document-version> --mime-type application/pdf
tw doc download <document-id> --file-version 1 --output ./original.pdf
```

Omit `--project` for a personal attachment. CLI downloads verify SHA-256 and
refuse to overwrite an existing destination. File version numbers are distinct
from document versions, which also count metadata edits.

REST uses raw streaming bodies and a URL-encoded JSON
`X-TW-Attachment-Metadata` header (maximum 16 KiB). Authenticated endpoints are:

- `POST /api/v1/documents/attachments`: title, description, tags, ownership,
  originalFilename and mimeType metadata plus raw file bytes.
- `PUT /api/v1/documents/{id}/file`: expectedVersion, originalFilename and
  mimeType metadata plus replacement bytes. A stale version returns 409.
- `GET /api/v1/documents/{id}/file`: original download; optional `fileVersion`
  selects historical bytes and `preview=true` selects an allowed inline MIME.
- `GET /api/v1/documents/{id}/files`: authorized historical file metadata.
- Existing document detail, metadata update, deletion and link endpoints apply.
  Attachment metadata updates require `expectedVersion`; content edits/reverts
  are rejected. To restore earlier bytes, download and upload a new file version.

Browser mutations require existing CSRF protections. Every read and write uses
live resource authorization. Public responses expose no storage path/object key.
Search matches attachment title, description and tags only; no extraction, OCR,
file-content indexing or embedding generation occurs.

## Coordinated backup and restore

1. Stop writes in both API and Web, including automated callers. Wait for active
   uploads/replacements to finish or stop them. Keep the write barrier until both
   snapshots are complete.
2. Back up PostgreSQL, including document/file history and deletion tombstones,
   using the deployment's normal database backup facility. At the same boundary,
   snapshot/copy the complete attachment directory and existing Skill storage.
   Retain original object paths, permissions and bytes. Protect backups outside
   the repository. Record the compatible application revision/migration state.
3. Restore the database and matching files into an isolated database and separate
   storage volume. Configure both processes to use the restored directory and
   restore required authentication secrets through the Secret facility.
4. Verify current and historical authorized downloads, byte counts/SHA-256,
   ownership denial, metadata and links. Verify Markdown and Skill packages.
   Recreate the isolated API container against the retained volume and repeat
   downloads before accepting the recovery procedure.

A database-only backup cannot restore originals. A file-only backup cannot
restore ownership/version pointers. Do not resume writes against mismatched
snapshots; image rollback alone does not undo migrations.

## Cleanup and recovery

Permanent document deletion records file-object tombstones transactionally.
Post-commit cleanup removes up to 100 objects per pass; failed cleanup leaves
retryable tombstones. To retry, an operator can run the exported
`cleanupAttachmentGarbage(db)` in a trusted maintenance process using the same
storage configuration. It must not be exposed as an unprotected public endpoint.
Historical files of a live document are never eligible for cleanup.

A process crash between writing bytes and database publication can leave an
unreferenced object or temporary file. Under a write barrier, compare an offline
storage inventory with **all** `document_file_versions.object_key` records and
pending `document_file_garbage` records. Quarantine unmatched objects and stale
`.uuid.tmp` files for a retention period before deletion. Do not infer liveness
from only `current_file_version_id`, filenames or age, and do not sweep during
uploads. Missing/corrupt referenced files cause a sanitized failure instead of
returning different bytes; restore the matching original from backup.
