# Recovery observations and operator decisions

The requirement recovery view reuses durable execution controls and the existing
recovery engine. `GET /api/v1/requirements/:id/execution-recovery-state` and the
Web `requirement.recoveryState` query require live read access to that requirement.
They do not grant daemon administration, node inventory or unrelated project
access. The response is a bounded observation, not a new execution authority.

Each control has its recorded creation time and its latest phase/update time.
Intermediate phase history is not retained by the existing table. A received
notification does not prove termination; a stopped/reconciling phase is a
supervisor report. A resumed phase means a recovery decision was recorded; it
cannot establish that a replacement is running or that the old remote process
has terminated. Reload and event loss read the same durable latest-state view.

Requirement-lane lease occupancy is shown independently. A held lease is not
proof of valid execution authorization; absence of a lease is not proof of an
available fleet slot. Daemon health and fleet/node capacity remain explicitly
unknown in this requirement-scoped view. It does not enumerate other actors'
nodes or calculate capacity from online status. A dependency-waiting lane can be
observed released while preserved work remains on its original node.

Only bounded node/state hints are projected from workspace metadata. Local paths,
raw summaries, arbitrary workspace keys and file contents are not projected.
Local metadata is not a shared checkpoint and does not reconstruct files on a
replacement node. Inspect preserved files and Git provenance through the existing
agent recovery workflow before using them.

Human evidence revalidation requires current `resource.write` permission. Manual
recovery requires current `project.manage` permission. Agent and execution-bound
credentials cannot make either decision. Action availability in a response is
only a UI hint; mutations re-check identity, permissions and the planning
revision transactionally. No old run is authorized by revalidation.

Automatic retry safety and the remaining attempt budget are shown separately
from manual decisions. An expired recovery deadline is an observation requiring
inspection, not permission to retry uncertain external operations. Real node
health, cross-node failover, private Git state and business acceptance still need
their own authorized validation.

## Web operator actions

The Web panel refreshes on reconnect/focus, polls the authorized durable state,
and hides previous data when reads fail or access changes. Technical identifiers
are available on demand. It does not reconstruct a phase history from SSE events.

Evidence review requires an explicit review confirmation and a bounded reason.
Manual recovery requires explicit outcome, durable-input, preserved-file/Git and
unconfirmed-termination review. The Web mutation sends the observed plan revision,
control update time and phase. Changes to those observations or permissions reset
confirmation; a decision failure clears the form and refreshes state. Mutations
have no automatic retry. If a response is lost, reconcile the durable observation
before reviewing another decision rather than assuming the write failed.

The shared REST recovery schema retains optional control timestamp/phase guards
for existing clients; Web requires both. Core still serializes all decisions and
rejects historical/already-resolved controls, replacement-owned lanes and closed
requirements. A late old-node acknowledgment cannot reopen a resolved control.
These checks do not force completion, force-push Git or undo an external call.
