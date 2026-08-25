---
'@rundown-org/core': major
'@rundown-org/cli': patch
---

# One Run Release interface for both release seams

Releasing a run from session targeting had two routes and five spellings of one
policy. `SessionService.releaseRunbook` / `releaseRunbooks` took a
`retainClaimsAsTerminal` boolean — or a `retainClaimsAsTerminalRunId` naming the
one batch member that keeps its claims — while the transaction-folded route
carried the same boolean into the mutation runner and projected it directly.
Sixteen call sites each converted "what did I just do to this run?" into "should
its claims survive?" for themselves, and omitting the option meant revoke, so a
site that said nothing chose the destructive direction by accident.

Both seams now take the same fact:

```ts
export type ReleaseRole = 'addressed' | 'collateral' | 'discarded';
export interface RunRelease { readonly runId: RunId; readonly role: ReleaseRole; }
export function projectRunReleases(session: SessionData, releases: readonly RunRelease[]): void;
```

`addressed` is the run the caller acted on and keeps its claims as terminal
evidence; `collateral` is a run swept up so an addressed run could close;
`discarded` is a run being destroyed. The mapping from role to claim disposition
is module-private, so a caller states what it did and cannot restate the policy.

`projectRunReleases` is batch-first, synchronous and in-place — the transaction
route projects through a session callback that accepts nothing else — validates
the whole batch before mutating, rejects a repeated run id as a programmer
error, treats an absent run as a no-op, and returns nothing. The old
`ReleaseRunbookResult` / `ReleaseRunbooksResult` payloads are removed; the only
reader of either was the batch method building a list nobody read.

`SessionService.releaseRunbook` and `releaseRunbooks` collapse into
`releaseRuns(releases)`. On the transaction route,
`EffectfulActorMutationRunnerInput.terminalRelease` becomes `{ role }`, present
when this mutation projects release on terminal and absent when it does not, and
`AggregateTerminalRelease` becomes `AggregateRunRelease` carrying a role beside
its existing `when` trigger. `runAll` now also refuses a release batch that
names one owned run twice, before it captures authority.
`LifecycleTerminalReleasePolicy`'s equal `onComplete` / `onStopped` switches
collapse to one `releaseOnTerminal` flag.

The CLI's `transition-orchestrator` loses its terminal-release branch rather
than migrating it. Terminal release moved inside core's fenced mutation some
time ago, and both production callers had been passing `releaseRunbook: false`
ever since; with the branch goes the refusal-downgrade that turned a refused
release into a `stopped`, which no production path could reach.
`orchestrateTransition` is now synchronous — it renders events and nothing else.

Every release keeps its present claim disposition, including the
already-terminal loop path, which stays `collateral` and so still revokes the
claim of a run it addressed. That is #781, and it is fixed on top of this
interface rather than inside it, so a regression in either is traceable to one
of them.
