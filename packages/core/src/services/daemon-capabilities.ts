const EXECUTOR_PREFIX = "executor:";
const LEGACY_EXECUTOR_PREFIX = "tool:";
const REQUIRED_CAPABILITY_PREFIX = "capability:";
const ANY_CAPABILITY_PREFIX = "capability-any:";
const RESERVED_CAPABILITIES = new Set(["review", "merge"]);

export interface DaemonCapabilityMatch {
  eligible: boolean;
  executorTool: string | null;
  allowedExecutors: string[];
  missingCapabilities: string[];
  missingAnyGroups: string[];
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function capabilityNames(capabilities: string[]) {
  return new Set(capabilities.flatMap((capability) => {
    if (capability.startsWith(REQUIRED_CAPABILITY_PREFIX)) {
      return [capability, capability.slice(REQUIRED_CAPABILITY_PREFIX.length)];
    }
    return [capability];
  }));
}

function advertisedExecutors(capabilities: string[]) {
  const namespaced = capabilities
    .filter((capability) => capability.startsWith(EXECUTOR_PREFIX))
    .map((capability) => capability.slice(EXECUTOR_PREFIX.length));
  if (namespaced.length > 0) return unique(namespaced);

  return unique(capabilities.filter((capability) =>
    !capability.includes(":") && !RESERVED_CAPABILITIES.has(capability),
  ));
}

export function matchDaemonTaskCapabilities(
  tags: string[] = [],
  daemonCapabilities: string[] = [],
): DaemonCapabilityMatch {
  const allowedExecutors = unique(tags.flatMap((tag) => {
    if (tag.startsWith(EXECUTOR_PREFIX)) return [tag.slice(EXECUTOR_PREFIX.length)];
    if (tag.startsWith(LEGACY_EXECUTOR_PREFIX)) return [tag.slice(LEGACY_EXECUTOR_PREFIX.length)];
    return [];
  }));
  const executors = advertisedExecutors(daemonCapabilities);
  const executorTool = executors.find((executor) =>
    allowedExecutors.length === 0 || allowedExecutors.includes(executor),
  ) ?? null;

  const available = capabilityNames(daemonCapabilities);
  const requiredCapabilities = unique(tags
    .filter((tag) => tag.startsWith(REQUIRED_CAPABILITY_PREFIX))
    .map((tag) => tag.slice(REQUIRED_CAPABILITY_PREFIX.length)));
  const missingCapabilities = requiredCapabilities.filter((capability) =>
    !available.has(capability) && !available.has(`${REQUIRED_CAPABILITY_PREFIX}${capability}`),
  );

  const anyGroups = new Map<string, string[]>();
  for (const tag of tags.filter((candidate) => candidate.startsWith(ANY_CAPABILITY_PREFIX))) {
    const value = tag.slice(ANY_CAPABILITY_PREFIX.length);
    const separator = value.indexOf(":");
    const group = separator === -1 ? "default" : value.slice(0, separator);
    const capability = separator === -1 ? value : value.slice(separator + 1);
    if (!capability) continue;
    anyGroups.set(group, [...(anyGroups.get(group) ?? []), capability]);
  }
  const missingAnyGroups = [...anyGroups.entries()]
    .filter(([, capabilities]) => !capabilities.some((capability) =>
      available.has(capability) || available.has(`${REQUIRED_CAPABILITY_PREFIX}${capability}`),
    ))
    .map(([group]) => group);

  return {
    eligible: executorTool !== null
      && missingCapabilities.length === 0
      && missingAnyGroups.length === 0,
    executorTool,
    allowedExecutors,
    missingCapabilities,
    missingAnyGroups,
  };
}
