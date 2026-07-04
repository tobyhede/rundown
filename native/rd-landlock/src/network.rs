//! Network sandboxing via classic seccomp-BPF.
//!
//! Classic seccomp can inspect syscall numbers and integer arguments, but it
//! cannot dereference `struct sockaddr *` pointers. The first network sandbox
//! therefore filters socket-family creation only: AF_UNIX sockets remain
//! available for local IPC, AF_NETLINK remains available for local kernel
//! metadata queries, and every other socket family fails with EACCES.

use crate::spec::NetworkPolicy;
use crate::sys;

/// Apply the requested network policy to the current process.
pub fn apply_network_policy(policy: NetworkPolicy) -> Result<NetworkPolicy, String> {
    match policy {
        NetworkPolicy::Allow => Ok(NetworkPolicy::Allow),
        NetworkPolicy::Deny => {
            sys::install_network_seccomp_filter()
                .map_err(|e| format!("network sandbox failed: {e}"))?;
            Ok(NetworkPolicy::Deny)
        }
    }
}
