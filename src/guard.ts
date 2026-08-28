/**
 * Actions-cost guard (2026-08-28, v0.8.1).
 *
 * Private-repo Actions minutes are consumed by push-triggered workflow runs
 * in the `in_progress` state (queued is free). The 2026-08-28 incident showed
 * how a push that stacks onto running jobs — or a debugging session that
 * re-fires tags — burns the monthly quota without doing any work. These
 * guards live at the only surface the plugin controls: `github_push_files`
 * and `github_create_release`. Local `git push` bypasses the plugin entirely
 * and is covered by the companion skill instead.
 *
 * Design rule: the guard must NEVER block work because the guard itself is
 * broken. Any API error on the pre-flight check fails OPEN (push allowed).
 */

export interface ActionsGuardOptions {
  enabled: boolean
  refuseOnInProgress: boolean
  tagCooldownMinutes: number
}

export const DEFAULT_GUARD_OPTIONS: ActionsGuardOptions = {
  enabled: true,
  refuseOnInProgress: true,
  tagCooldownMinutes: 30,
}

export interface GuardRunSummary {
  name: string | null
  head_branch: string | null
  html_url: string | null
  created_at: string | null
}

export type InProgressVerdict =
  | { blocked: false }
  | { blocked: true; code: 'push_guard_in_progress'; message: string; runs: GuardRunSummary[] }

export interface InProgressChecker {
  (owner: string, repo: string, signal?: AbortSignal): Promise<InProgressVerdict>
}

/**
 * Build the in-progress check against the GitHub API. The shape of the runs
 * payload is intentionally narrow: only the fields the refusal message needs.
 */
export function makeInProgressChecker(
  api: { listActionRuns(owner: string, repo: string, opts?: { status?: string; perPage?: number }, signal?: AbortSignal): Promise<{ ok: boolean; status: number; data: unknown }> },
  guard: ActionsGuardOptions,
): InProgressChecker {
  return async (owner, repo, signal) => {
    if (!guard.enabled || !guard.refuseOnInProgress) return { blocked: false }
    let response: { ok: boolean; status: number; data: unknown }
    try {
      response = await api.listActionRuns(owner, repo, { status: 'in_progress', perPage: 10 }, signal)
    } catch {
      // Fail-open: network/transport problems must not wedge the tool.
      return { blocked: false }
    }
    if (!response.ok) return { blocked: false } // fail-open on 403/404/…
    const data = response.data as { total_count?: number; workflow_runs?: Array<Record<string, unknown>> } | undefined
    const runs = Array.isArray(data?.workflow_runs) ? data!.workflow_runs! : []
    if (runs.length === 0) return { blocked: false }
    const shaped: GuardRunSummary[] = runs.slice(0, 5).map(r => ({
      name: typeof r.name === 'string' ? r.name : null,
      head_branch: typeof r.head_branch === 'string' ? r.head_branch : null,
      html_url: typeof r.html_url === 'string' ? r.html_url : null,
      created_at: typeof r.created_at === 'string' ? r.created_at : null,
    }))
    const more = runs.length > shaped.length ? ` (and ${runs.length - shaped.length} more)` : ''
    return {
      blocked: true,
      code: 'push_guard_in_progress',
      message:
        `Actions-cost guard: ${runs.length} workflow run(s) already in progress on ${owner}/${repo}${more}. ` +
        'A new push would stack onto billed jobs. Wait for them to finish, cancel via the API, or set github-tools.actionsGuardEnabled=false to opt out.',
      runs: shaped,
    }
  }
}

/** In-memory per-process tag cooldown for github_create_release. */
export class TagCooldown {
  private readonly lastCreated = new Map<string, number>()

  constructor(
    private readonly guard: ActionsGuardOptions,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Refusal message when `key` was marked inside the cooldown window (no mutation). */
  checkBlocked(key: string): { blocked: false } | { blocked: true; code: 'release_tag_cooldown'; message: string } {
    if (!this.guard.enabled) return { blocked: false }
    const windowMs = this.guard.tagCooldownMinutes * 60_000
    if (windowMs <= 0) return { blocked: false }
    const last = this.lastCreated.get(key)
    if (last === undefined) return { blocked: false }
    const elapsed = this.now() - last
    if (elapsed >= windowMs) return { blocked: false }
    const waitMinutes = Math.max(1, Math.ceil((windowMs - elapsed) / 60_000))
    return {
      blocked: true,
      code: 'release_tag_cooldown',
      message:
        `Actions-cost guard: tag '${key}' was created ${Math.round(elapsed / 60_000)} minute(s) ago; ` +
        `cooldown is ${this.guard.tagCooldownMinutes} minute(s) (~${waitMinutes} min left). ` +
        'Re-firing tags for debugging burns Actions minutes — prefer workflow_dispatch, or opt out via github-tools.actionsGuardTagCooldownMinutes.',
    }
  }

  /** Record a successful creation. Only call this after the API succeeded. */
  mark(key: string): void {
    this.lastCreated.set(key, this.now())
  }
}
