# Personal Chat credentials

Chat resolves the authenticated account's selected or default model. It uses only an
API key saved in that account's model settings. Unknown credential status allows a
saved key; missing or invalid status asks the user to review it. Connection tests
send a short request to the saved model without changing its status.

The upgrade adds nullable encrypted credential columns. Existing provider, model,
base URL, defaults and conversations remain intact. Old environment references do
not provide Chat credentials: users must enter their own keys. Deployment secrets
are never imported. Task executor provider configuration is a separate interface.

Configure `TW_CHAT_CREDENTIAL_MASTER_KEY` as a base64-encoded, random 32-byte key in
the deployment Secret facility. Set an optional `TW_CHAT_CREDENTIAL_KEY_ID` (default
`primary`). All Web and API processes must use the same key ring. Do not put key
values in source control, logs, platform documents or command arguments.

The Kubernetes template reads optional keys `master-key`, `key-id` and
`previous-keys` from `task-weaver-chat-credentials`. Missing configuration does
not prevent startup, but saving personal keys requires a valid master key.
Provision that Secret before enabling personal Chat configuration.

Credentials use AES-256-GCM with random 12-byte nonces, authenticated owner/model
bindings and a versioned ciphertext envelope. Public responses expose only a fixed
mask and presence metadata. Replacing a key takes effect on the next Chat request;
deleting it clears both the ciphertext and old reference. Existing in-flight
requests may finish with the key they already resolved.

Back up the database and encryption key ring separately. Losing the master key
makes existing ciphertext unreadable; restore the ring or ask users to replace
keys. Database backups alone cannot recover credentials.

For rotation, retain the previous key in `TW_CHAT_CREDENTIAL_PREVIOUS_KEYS`, a Secret
containing a JSON object of key IDs to base64 keys. Choose a new key ID and master
key, and distribute the complete ring consistently. Old envelopes remain readable;
replacing a saved key encrypts it under the current key. Keep previous keys while
any stored envelope or retained backup still needs them. This release does not
perform an automatic bulk re-encryption.

Custom model endpoints must use public HTTPS on port 443. DNS results are checked
and pinned to the TLS connection; private, loopback, metadata and special-use
addresses are rejected. Redirects are not followed. Requests have a 45-second
absolute timeout and responses are limited to 1 MiB. Provider error bodies are not
returned to users or logged. Private gateways require a separately designed trust
policy and are not supported by this self-service interface.

Assistant action settings apply across all chats for the current account. Task and
assistant policy writes change separate columns; saving either does not reset the
other. Preview mode creates reviewable proposals without automatically applying
resource changes. Manual approval always rechecks live resource permissions.
