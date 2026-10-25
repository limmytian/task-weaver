import type { ExecutionRecoveryView } from "@task-weaver/contracts";

const phaseLabels = {
  pending: "Stop requested", received: "Stop request received", stopping: "Stopping previous execution",
  stopped: "Stop reported", reconciling: "Assessing preserved work", resumed: "Recovery decision recorded",
  blocked: "Waiting for executable inputs", manual: "Operator decision needed",
} as const;
const stamp = (value: string) => value.replace("T", " ").replace("Z", " UTC");

function ControlObservation({ control }: { control: ExecutionRecoveryView["controls"][number] }) {
  return <article className="space-y-2 rounded border p-3">
    <h4 className="font-medium">{phaseLabels[control.phase]}</h4>
    <p>{control.reason}</p>
    <ol className="list-inside list-decimal space-y-1 text-muted-foreground">
      {control.observations.map(observation => <li key={observation.kind}>
        {observation.kind === "created" ? "Control recorded" : `Latest update: ${phaseLabels[control.phase]}`} · <time dateTime={observation.at}>{stamp(observation.at)}</time>
      </li>)}
    </ol>
    <p className="text-muted-foreground">Intermediate phase timestamps were not recorded. Notification receipt does not prove termination.</p>
    <p>{control.stopObservation === "reported_in_current_phase" ? "The supervisor reports termination in the current phase." : "Termination is not established by this record."}</p>
    <p>Recovery deadline: <time dateTime={control.deadline}>{stamp(control.deadline)}</time>{control.deadlinePassed ? " · elapsed; inspect preserved work and uncertain outcomes" : ""}.</p>
    {control.preservedState && <p>Preserved local state: {control.preservedState}. Local metadata does not reconstruct files on another node.</p>}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Technical details</summary>
      <dl className="mt-2 space-y-1 break-all"><div><dt className="inline">Control: </dt><dd className="inline">{control.id}</dd></div><div><dt className="inline">Previous run: </dt><dd className="inline">{control.runId}</dd></div><div><dt className="inline">Daemon: </dt><dd className="inline">{control.daemonId}</dd></div><div><dt className="inline">Recorded node: </dt><dd className="inline">{control.nodeId ?? "Unknown"}</dd></div><div><dt className="inline">Plan revision: </dt><dd className="inline">{control.revision}</dd></div></dl>
    </details>
  </article>;
}

export function RecoveryObservationView({ view }: { view: ExecutionRecoveryView }) {
  const [latest, ...previous] = view.controls;
  return <div className="space-y-3">
    <p className="text-muted-foreground">Observed <time dateTime={view.observedAt}>{stamp(view.observedAt)}</time> · plan revision {view.planRevision}.</p>
    <dl className="grid gap-2 sm:grid-cols-2">
      <div><dt className="font-medium">Requirement lane</dt><dd>{view.lane.state === "held" ? "Lease held; execution authorization is not established by this observation." : "No live lane lease observed; a free fleet slot is not established."}</dd></div>
      <div><dt className="font-medium">Worker availability</dt><dd>Unknown. This view does not observe node health or fleet capacity.</dd></div>
      <div><dt className="font-medium">Retry budget remaining</dt><dd>{view.retry.remaining} of {view.retry.maximum} · {view.retry.used} attempts recorded.</dd></div>
      <div><dt className="font-medium">Retry safety</dt><dd>{view.retry.automaticRetrySafe ? "Configured as retry-safe; local progress may be lost and computation duplicated." : "Unknown or unsafe; inspect external outcomes and required inputs before manual recovery."}</dd></div>
    </dl>
    {latest ? <ControlObservation control={latest} /> : <p className="text-muted-foreground">No recovery control recorded.</p>}
    {previous.length > 0 && <details><summary className="cursor-pointer">Previous recovery controls ({previous.length})</summary><div className="mt-3 space-y-3">{previous.map(control => <ControlObservation key={control.id} control={control} />)}</div></details>}
  </div>;
}
