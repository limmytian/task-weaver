# Personal Chat credentials

Chat resolves the authenticated account's selected or default model. It uses only an
API key saved in that account's model settings, when one is provided. API keys are
optional for every provider. Without a saved key, no Authorization header is sent.
Credential status is informational; connection tests and Chat requests determine
whether the server accepts the configuration. Connection tests send a short request
to the saved model without changing its status. A valid token-limited empty reply
from a thinking model can confirm connectivity; ordinary Chat still requires
readable content or complete tool calls.

The upgrade adds nullable encrypted credential columns. Existing provider, model,
base URL, defaults and conversations remain intact. Old environment references do
not provide Chat credentials: users must enter their own keys if the server requires them. Deployment secrets
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

Custom model endpoints support HTTP, HTTPS, local addresses and custom ports.
Saving a model opens a confirmation showing the configured address and explaining
that requests originate from the server and HTTP does not encrypt messages or keys.
“Don’t show again on this device” stores only a warning preference in that browser's
local storage; it does not change account or resource permissions. Addresses are
resolved and pinned for each connection, and redirects are not followed. URLs must
not contain embedded credentials, query parameters or fragments. Requests retain
bounded timeouts and 1 MiB response limits. Provider error bodies are not returned
to users or logged.

For local Ollama, choose any Provider label, use the installed model name and set Base
URL to `http://<host>:11434/v1` (or the server's configured port). Leave API Key blank
unless a gateway requires it. Connection tests are available without a saved key.
The Web/API containers must be able to reach the endpoint; confirming a URL does
not change network routing or the Ollama server's listening address.

Assistant action settings apply across all chats for the current account. Task and
assistant policy writes change separate columns; saving either does not reset the
other. Chat presents a single operation permission: read only or operations allowed.
When allowed, the model can use validated platform operations for projects,
requirements, tasks, dependencies, execution slices, documents, notes and schedules.
Operations use the same verified business services as REST and the CLI, with the
signed-in account as the actor. Existing action allowlists and daily assistant limits
do not restrict this permission. Project execution policies, resource permissions,
active leases and dependency rules remain independent and are rechecked for each
operation. Each operation records its actual outcome in the conversation. Local CLI
process management and shell execution are not Chat tools.

Page Chat follows the current route: global outside a project, project within a
project, and requirement on requirement detail pages. Task detail Chat supplies a
task context; each schedule's Chat button supplies a schedule context. Changing the
resource starts a separate conversation. Messages scroll independently of the input
composer; Enter sends, Shift+Enter adds a newline and IME composition does not send.

Operation tools advertise their exact shared input schemas directly to the model.
The UI assigns a request ID to each send. If the connection times out, it queries
the original request's account-scoped result while keeping the send guard active;
it does not resubmit the operation. Failed sends retain the draft. Result queries
recheck conversation and resource access, including after permission revocation.

A request ID is unique within its verified account. Retrying the same completed
request returns its recorded result without another model call or resource write.
Different input cannot reuse an existing ID. The database enforces uniqueness for
concurrent submissions. Tool execution has a five-minute budget for multi-step
operations; connection recovery waits for that original request. Compact model
context omits full resource bodies, while live reads record related resource IDs
for authorization checks on both the response and later history reads.

Model requests honor deployment `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`
(and their lowercase equivalents) through a dedicated HTTP(S) agent. This requires
Node.js 24.5 or newer when a proxy is configured. The proxy applies to connection
tests, ordinary replies and streaming replies in both Web and API. Set `NO_PROXY`
for local model endpoints and internal services. Direct connections retain DNS
pinning; HTTPS proxy connections retain certificate verification. Redirects remain
rejected, and proxy configuration does not change account or resource permissions.
