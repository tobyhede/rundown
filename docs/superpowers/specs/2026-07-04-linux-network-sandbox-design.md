# Linux network sandbox: default-deny seccomp isolation for `rd-landlock`

- **Date:** 2026-07-04
- **Issue:** [#525](https://github.com/tobyhede/rundown/issues/525)
- **Status:** Draft for review
- **Scope:** Extend the existing first-party `rd-landlock` helper with
  default-deny network isolation for sandboxed Linux commands.

## Problem

Rundown's Linux sandbox now applies filesystem restrictions through the bundled
`rd-landlock` helper. Landlock controls filesystem access; it does not prevent a
sandboxed command from opening sockets and exfiltrating data it was allowed to
read. The current default policy reduces this risk by denying common network
tools such as `curl`, `wget`, `ssh`, and `nc`, but command denial is not syscall
isolation: an allowed interpreter or test runner can still open sockets directly.

This is inconsistent with Rundown's sandbox posture. File access is denied unless
policy grants it, unavailable sandboxing fails closed by default, and Linux
under-enforcement blocks execution rather than silently weakening policy. Network
access should follow the same model.

## Goals

- Deny outbound and listening network access by default for Linux commands that
  run under the OS sandbox.
- Require explicit policy intent to allow network access for trusted runbooks.
- Fail closed when the active policy requires network denial but the helper
  cannot install the network filter.
- Preserve local filesystem sandbox behaviour and the existing fd-3/fd-4 helper
  protocol shape.
- Keep local Unix-domain IPC usable where the seccomp mechanism can distinguish
  it from IP networking.
- Surface the enforced network posture alongside existing sandbox result fields
  so callers can tell whether network access was denied or allowed.

## Non-goals

- This design does not use Landlock network rights. Landlock TCP rights appear
  in ABI v4 and UDP rights in later ABIs, but seccomp is the chosen mechanism for
  this work because it is independent of Landlock network ABI coverage.
- This design does not add host, port, or protocol allow-lists. Network is a
  coarse policy posture: `deny` or `allow`.
- This design does not implement macOS network denial. The macOS Seatbelt profile
  currently allows network access; parity can be evaluated separately. Until
  that work exists, macOS must not report `networkSandboxed:true` merely because
  policy parsed as `network: deny`.
- This design does not solve inherited network file descriptors. The helper
  should not create new network sockets when network is denied, but a parent
  process could theoretically pass an already-open network fd. Closing
  unexpected inherited fds is a separate hardening task.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Default posture | `deny` network for sandboxed Linux commands | Matches default-deny policy and fail-closed sandbox semantics. |
| Opt-out | Explicit policy intent, plus existing trust modes that disable sandboxing | Trusted runbooks can request network; `--no-sandbox` and `--allow-all` remain louder broader opt-outs. |
| Enforcement mechanism | seccomp-BPF in `rd-landlock` | The helper already runs in the child immediately before `exec`, where irreversible process restrictions belong. |
| Filter model | Allow only Unix-domain and netlink socket families while denying every other socket family and alternate io_uring socket creation paths | Classic seccomp cannot safely inspect pointed-to `sockaddr` contents; filtering socket-family arguments is the practical boundary, with explicit syscall-number denies for known alternate socket creation surfaces. |
| Failure behaviour | Fail closed when `network: deny` cannot be enforced | Reporting sandbox success while network remains open would weaken policy. |
| Policy granularity | Coarse `deny` / `allow` | Host/port allow-lists would require a much larger resolver and enforcement design. |

## Policy model

Add a network posture to policy defaults and runbook overrides:

```yaml
default:
  network: deny

overrides:
  - runbook: "deploy/*.runbook.md"
    network: allow
```

`network` is not a glob-rule permission like `run`, `read`, `write`, or `env`.
It is a sandbox capability posture with exactly two values:

- `deny` — the sandbox must install network isolation before running the command.
- `allow` — the sandbox does not install the network filter.

The built-in default is `deny`. Existing policy files that omit `network` parse
as `deny`, which is an intentional tightening because network exfiltration is
part of the sandbox threat model. Users that need network access add an explicit
policy override for the runbook or command surface that needs it.

The existing trust modes keep their meanings:

- `--no-sandbox` disables OS sandboxing entirely, including network isolation.
- `--allow-all` disables policy and sandboxing as trust mode.
- `sandboxStrict:false` may relax ABI-floor refusal for filesystem Landlock
  downgrade, but it must not silently convert a required network denial into
  network access. If `network: deny` is active and seccomp cannot be installed,
  the helper returns an error status and core fails closed.

## Core interface

Extend `SandboxOptions` with a network posture:

```typescript
export type SandboxNetworkPolicy = 'deny' | 'allow';

export interface SandboxOptions {
  // existing fields...
  network: SandboxNetworkPolicy;
}
```

`policyToSandboxOptions()` reads the effective network posture from the
`PolicyEvaluator`. The evaluator should expose a typed method such as
`getEffectiveNetworkPolicy()` instead of forcing callers to interpret generic
permission rules.

The Linux `LandlockSpec` sent on fd 3 gains the same field:

```typescript
export interface LandlockSpec {
  command: string;
  strict: boolean;
  ro: string[];
  rox: string[];
  rw: string[];
  network: 'deny' | 'allow';
}
```

The helper's Rust `Spec` gains `network` with a default of `deny` so malformed or
older core callers do not fail open:

```rust
pub enum NetworkPolicy {
    Deny,
    Allow,
}
```

## Status and result surfacing

The fd-4 `applied` status reports the enforced network posture:

```json
{"status":"applied","abi":3,"downgraded":false,"network":"deny"}
```

Core validates this field when parsing status. `SandboxExecutionResult` gains:

```typescript
networkSandboxed?: boolean;
networkPolicy?: 'deny' | 'allow';
```

For `network: deny`, `networkSandboxed` is `true` only after the helper reports
that the filter was installed. For `network: allow`, `networkSandboxed` is
`false` and `networkPolicy` is `allow`.

`COMMAND_COMPLETED` and command execution observation payloads should carry these
fields through the same path as `sandboxed`, `landlockAbi`, and
`enforcementDowngraded`.

## Helper enforcement

`rd-landlock` applies restrictions in this order:

1. Read and parse fd-3 spec.
2. Read negotiated Landlock ABI.
3. Decide strict filesystem enforcement as today.
4. Apply Landlock filesystem ruleset.
5. If `network: deny`, install seccomp network filter.
6. Write and flush fd-4 status.
7. `exec` `/bin/sh -c <command>`.

Landlock already sets `PR_SET_NO_NEW_PRIVS` via the `landlock` crate before
`restrict_self()`. The helper must ensure `no_new_privs` is set before seccomp
filter installation as well. Re-setting it explicitly before installing seccomp
is acceptable and clearer than relying on the Landlock call order.

If seccomp filter installation fails while `network: deny` is active, the helper
writes `{"status":"error","message":"network sandbox failed: ..."}` and does not
exec. Core treats that as a protocol/enforcement failure and fails closed.

If `network: allow`, the helper does not install the network filter and reports
`network:"allow"` in the applied status.

## Seccomp filter shape

Classic seccomp-BPF can inspect syscall numbers and integer syscall arguments.
It cannot safely dereference pointer arguments such as `struct sockaddr *` passed
to `connect(2)` or `bind(2)`. Therefore the AF_UNIX exemption must be based on
syscalls whose address family is an integer argument, primarily `socket(2)`.

The deny filter should be an allowlist for local socket families:

- allow `socket(AF_UNIX, ...)`;
- allow `socket(AF_NETLINK, ...)` so local kernel metadata operations such as
  `getifaddrs(3)`, interface enumeration, and common NSS paths keep working;
- deny every other `socket()` family with `EACCES`, including `AF_INET`,
  `AF_INET6`, `AF_PACKET`, `AF_VSOCK`, Bluetooth families, and other kernel
  network transports;
- allow `socketpair(AF_UNIX, ...)`;
- deny every other `socketpair()` family with `EACCES`;
- deny `io_uring_setup(2)`, `io_uring_enter(2)`, and
  `io_uring_register(2)` so commands cannot create sockets through
  `IORING_OP_SOCKET`;
- on x86_64, reject syscall numbers carrying the x32 syscall bit before the
  filter's default allow path;
- deny `connect`, `bind`, `listen`, `accept`, `accept4`, `sendto`, `sendmsg`,
  and `sendmmsg` only where denying them does not break AF_UNIX or AF_NETLINK
  operations that were intentionally allowed.

Because `connect` and `bind` cannot be filtered by dereferencing sockaddr family,
the implementation should start with a conservative, tested profile:

- deny AF_INET and AF_INET6 socket creation;
- deny unclassified socket families by default;
- allow AF_UNIX socket operations needed by shells, Node, package managers, and
  local IPC;
- allow AF_NETLINK operations needed for local kernel metadata queries;
- add broad `connect`/`bind` denial only if integration tests prove it does not
  break AF_UNIX local IPC or AF_NETLINK local metadata queries.

This avoids a misleading promise that seccomp can distinguish AF_UNIX from IP
inside `connect(2)`.

Allowing `AF_NETLINK` is deliberate. Netlink is a kernel/userspace local metadata
channel rather than an IP exfiltration channel, and blocking it breaks common
local operations such as `os.networkInterfaces()`, `getifaddrs(3)`, interface
enumeration, and some NSS paths. The implementation must include at least one
realistic local-command compatibility test under `network: deny` that exercises
these local lookups.

## Failure modes

| Scenario | Behaviour |
| --- | --- |
| `network: deny`, seccomp installs | Command runs with filesystem sandbox and network denial; result reports `networkSandboxed:true`. |
| `network: deny`, seccomp unavailable or rejected | Helper emits error and does not exec; core fails closed. |
| `network: allow` | Command runs with filesystem sandbox only; result reports `networkSandboxed:false`. |
| `--no-sandbox` | Command runs without filesystem or network sandboxing. |
| `--allow-all` | Trust mode; policy and sandbox are disabled. |
| macOS Seatbelt | Unchanged by this work; current profile continues to allow network. |

## Testing

Core TypeScript tests:

- policy schema parses omitted `network` as `deny`;
- runbook overrides can set `network: allow`;
- `policyToSandboxOptions()` maps effective network posture to
  `SandboxOptions.network`;
- `buildSpec()` serializes the posture to fd 3;
- fd-4 parser accepts applied statuses with `network:"deny"` and
  `network:"allow"`;
- malformed or missing network status fails closed rather than defaulting to
  success;
- `SandboxExecutionResult` and command observation payloads carry network fields.

Rust helper tests:

- spec parsing defaults omitted `network` to `Deny`;
- `network:"allow"` skips filter installation;
- `network:"deny"` calls the seccomp filter installer;
- seccomp installer errors become fd-4 error statuses and prevent exec.

Linux enforcement integration tests, gated like the existing Landlock tests:

- with `network: deny`, `python3 -c` or `node -e` attempting TCP connect to
  `127.0.0.1` fails;
- with `network: deny`, creating or using an AF_UNIX socket succeeds;
- with `network: allow`, TCP socket creation is not blocked by the sandbox;
- filesystem Landlock enforcement still works in the same run.

## Documentation

Update `docs/reference/security.md` to state:

- Linux sandboxed commands default to no network access;
- network access requires explicit policy opt-in;
- `--no-sandbox` disables both filesystem and network sandboxing;
- macOS network behaviour is unchanged until a separate Seatbelt design covers
  it;
- inherited network file descriptors are outside this first implementation.

## Issue rewrite

Issue #525 should be rewritten from "once `rd-landlock` lands" to "extend the
existing `rd-landlock` helper." The issue should call out the seccomp limitation
around `connect(2)`/`sockaddr` inspection and make default-deny network posture
an acceptance criterion.

## Acceptance criteria

- Linux sandbox policy defaults to `network: deny`.
- Users can explicitly set `network: allow` in policy for trusted runbooks.
- The fd-3 spec carries network posture to `rd-landlock`.
- The fd-4 status reports the posture that was enforced.
- `network: deny` installs a seccomp filter before exec.
- If the filter cannot be installed, the command does not run and core reports a
  policy/sandbox denial.
- TCP socket attempts fail under `network: deny` in gated Linux enforcement
  tests.
- AF_UNIX socket usage succeeds under `network: deny`.
- `network: allow` preserves existing filesystem sandboxing without network
  filtering.
- Docs describe default-deny Linux network behaviour and opt-out paths.
