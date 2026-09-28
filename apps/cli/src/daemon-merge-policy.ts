export type MergeMode = 'provider' | 'direct' | 'manual'
export type RequestedMergeMode = MergeMode | 'auto'

export interface EffectiveMergePolicy {
  allowedMergeModes: MergeMode[]
  defaultMergeMode: MergeMode
  baseBranch: string
}

export interface ManualMergeTarget {
  pullRequestUrl?: string | null
  repositoryWebUrl?: string | null
  baseBranch: string
  workingBranch: string
}

export function selectMergeMode(
  policy: EffectiveMergePolicy,
  requestedMode: RequestedMergeMode,
): MergeMode {
  const selected = requestedMode === 'auto' ? policy.defaultMergeMode : requestedMode
  if (!policy.allowedMergeModes.includes(selected)) {
    throw new Error(`Merge mode '${selected}' is not allowed by the effective review policy`)
  }
  return selected
}

export function manualMergeActionUrl(target: ManualMergeTarget): string | null {
  if (target.pullRequestUrl) return target.pullRequestUrl
  if (!target.repositoryWebUrl) return null
  const root = target.repositoryWebUrl.replace(/\/$/, '')
  const base = encodeURIComponent(target.baseBranch)
  const head = encodeURIComponent(target.workingBranch)
  if (/github\.com\//i.test(root)) return `${root}/compare/${base}...${head}?expand=1`
  if (/gitea|forgejo/i.test(root)) return `${root}/compare/${base}...${head}`
  return root
}
