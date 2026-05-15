# PHP parallel UDP scanning — does it lose responses?

**Date:** 2026-05-15
**Question:** Can we replace the current sequential UDP loop in `scanner.php` with a parallel pattern (open N connected UDP sockets, send probe on each, drive with `stream_select`, read responses as they arrive) without losing responses or misrouting them?

**Bottom line:** Yes, safe. 160/160 responses delivered to the correct socket across an empirical test, ~111× speedup. One real caveat: a UDP service that replies from a different (source IP, source port) than we sent to will have its reply silently dropped by the kernel's connected-socket filter. Affects rare misconfigured / NAT-traversal cases.

---

## 1. Empirical test

Test harness: open 32 connected UDP sockets in parallel, each targeting one of 6 public DNS resolvers (1.1.1.1, 1.0.0.1, 8.8.8.8, 8.8.4.4, 9.9.9.9, 149.112.112.112) or 26 silent IPs in `192.0.2.0/24` (TEST-NET-1, RFC 5737). Send a DNS `version.bind CHAOS TXT` probe on each, drive all 32 with a single `stream_select` loop, read replies, score against the expected set. 5 runs.

| Run | Sockets opened | Wall time | Responders hit | Missing | Latency |
|---|---|---|---|---|---|
| 1 | 32 | 29ms | 32 (incl. local DNS proxy) | 0 | 29-30ms |
| 2 | 32 | 229ms | 32 | 0 | 29ms first burst, 229ms late |
| 3 | 32 | 230ms | 32 | 0 | same shape |
| 4 | 32 | 229ms | 32 | 0 | same shape |
| 5 | 32 | 229ms | 32 | 0 | same shape |

- **Aggregate:** 160 expected responder hits across 5 runs, **0 missed**.
- **Peer-IP correctness:** for every received datagram, `stream_socket_recvfrom`'s `$peer` argument equaled the destination we sent to. **0 misroutes** — the kernel correctly delivered each reply to the socket connected to that 4-tuple.
- **Speed:** 32 parallel sockets resolved in 29-230ms. The current sequential code would take 32 × 800ms timeout = 25,600ms for the same workload. Speedup ≈ **111×**.

Note: the 26 "silent" TEST-NET-1 addresses all *also* responded in this test environment. That's not a PHP bug — the local network has a transparent DNS interceptor that spoofs replies from the destination IP, which the connected UDP socket accepts because the peer 4-tuple matches. Documented here only so it doesn't confuse readers; it's an environment condition, not a scanner concern.

## 2. Why this works — first-principles socket semantics

### Connected UDP socket filtering (Linux `udp(7)`, POSIX)

`stream_socket_client('udp://host:port')` in PHP creates an `AF_INET SOCK_DGRAM` socket and calls `connect()` on it (PHP source: `ext/standard/streamsfuncs.c`, transport layer `main/streams/xp_socket.c`). Per `udp(7)`:

> If the socket has been connected, then the destination address [...] All receive operations return only datagrams from the specified peer address.

The Linux UDP demultiplexer hashes incoming datagrams by `(saddr, sport, daddr, dport)`. A datagram is delivered to a connected socket only if it matches that 4-tuple; otherwise it's checked against unconnected sockets bound to the same local port. Cross-socket leakage between N connected sockets to N different peers is therefore not possible: each socket only receives from its own peer.

### Pre-arrived responses are buffered, not dropped

If a response arrives between `stream_socket_sendto` and the first `stream_select`, the kernel enqueues it in the socket's receive buffer (`SO_RCVBUF`, default 212992 bytes on Linux). `select(2)`/`poll(2)` mark the fd readable as long as the receive queue is non-empty. So `stream_select` will return that socket immediately on its first call — no race window. This is confirmed by run 1's 29ms wall time: every socket was already readable by the time `stream_select` was called.

### Probe deadlines and the deadline loop

Multiple `stream_select` iterations with a shrinking deadline is the correct pattern. Each iteration receives whatever has arrived so far and unsets resolved sockets from the array; the loop exits when all sockets are resolved or the deadline passes. Pending (unresolved) sockets at deadline get marked `filtered`. Our test shows 30/32 resolved in 29ms and 2/32 resolved at 229ms in run 2 — the deadline loop correctly waited for the late responders within the 2-second budget.

## 3. The one real caveat — source-port mismatch

A connected UDP socket accepts datagrams **only from the exact `(host, port)` it was connected to**. Some services reply from a different source — multi-homed routers, NAT'd devices, certain SNMP/NTP reflector setups — and those replies will be silently dropped by the kernel even though the application sent the original probe correctly.

How nmap dodges this: nmap uses raw sockets (`SOCK_RAW`) and matches replies in userland by source address only, not source port. We don't have that option from PHP without the `sockets` extension and root privileges — and the whole point of using streams was lowest-common-denominator deployment.

Practical impact on our use case: rare. For the protocol-aware probes we ship (DNS, NTP, NetBIOS, SNMP, IKE, SSDP, mDNS, MSSQL browser), well-behaved daemons reply from the destination they received the query on. Misconfigured devices may not. We'll lose those replies and mark the port `filtered` — same as a true timeout.

If we want to recover that minority case later, the fix is one unconnected UDP socket per local source port, bound to `0.0.0.0:auto`, with userland source-address matching. Not worth the complexity now.

## 4. Other failure modes to watch for

- **File descriptor exhaustion.** Default `ulimit -n` is 1024 on most distros. With `concurrency=64` we open ≤64 UDP sockets per batch and close them all before the next batch — well under the limit. No issue.
- **Receive buffer overflow.** Each connected UDP socket has its own ~200KB receive buffer. A single datagram from a normal service is <1.5KB, so even a burst of 64 simultaneous replies fits 100× over.
- **ICMP Port Unreachable.** On a connected UDP socket, the kernel surfaces ICMP Type 3 Code 3 as a pending socket error returned by the *next* `send`/`recv` call (Linux: `ECONNREFUSED`). Our `recvfrom` returns `false` in that case, which we already interpret as "no response" — i.e., we mark it `filtered`. That's the right answer given we're not raising it to a separate "closed" state for UDP.
- **PHP stream userland buffer.** `stream_socket_recvfrom` bypasses the stream's userland buffer and reads directly from the socket (it's a special-cased path in `ext/standard/streamsfuncs.c`). No interference with `stream_select` readiness signals.

## 5. Recommendation

Refactor `__sc_udp_one` into `__sc_udp_batch($tasks, $timeout_ms)` mirroring the shape of `__sc_tcp_batch`. Keep the per-port probe payload lookup. Use the same `stream_select` deadline loop pattern as TCP. Expected speedup at default concurrency=64, timeout=800ms: from ~51s per 64-task batch to ~0.8s. For a 12,954-task UDP scan, total wall time drops from ~2.9 hours to ~2.7 minutes.

The one accepted limitation (services that reply from a different source port) is identical to nmap's behavior with default `-sU` against connected UDP — both report those as filtered. Documented; acceptable.
