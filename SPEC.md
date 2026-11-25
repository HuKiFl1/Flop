# Stale-Channel Escrow Reclaim: Specification

Status: draft v0.1. The reference implementation is in `src/`, and every rule
below is covered by `tests/`.

## 1. Scope

A **lender** (an individual or a pool) escrows credit into a payment channel
between a **payer** (an agent buying inference) and a **provider** (a miner
selling inference). The payer may also escrow some of its own credit. Payer
and provider exchange off-ledger state updates. Some of these are
**finalized**, meaning they are recorded in the ledger with a strictly
increasing nonce and a cumulative amount owed to the provider.

This spec covers one thing: what happens when a channel's finalized state stops
advancing. It defines when the escrow can be reclaimed, how much, in what order
it is paid out, and who may trigger the reclaim. It does not cover pricing,
pool math, cooperative close, top-ups, or partial withdrawals (see the README's
Open questions).

## 2. Conventions

- All amounts are non-negative integers in the smallest indivisible unit of
  credit (`bigint` in the implementation). There are no floating-point values
  and no rounding.
- Time is measured only in **block height** `h ∈ ℕ`, which the caller supplies.
  The spec never refers to wall-clock time.
- `min`, `max` and subtraction are exact integer operations.
- `⊥` means "absent".

## 3. Parameters

| Symbol | Name                    | Constraint | Meaning                                                              |
| ------ | ----------------------- | ---------- | -------------------------------------------------------------------- |
| `N`    | `stalenessBlocks`       | `N ≥ 1`    | Blocks without a newer finalized state before a channel is Stale.     |
| `W`    | `challengeWindowBlocks` | `W ≥ 1`    | Length of the challenge window in blocks.                            |
| `T`    | `triggerPolicy`         | see §8     | Who may initiate and execute a reclaim.                              |
| `V`    | `verifyState` (optional)| pure, deterministic | Authenticity predicate for finalized states, e.g. a co-signature check. |

The parameters are fixed for the lifetime of a ledger.

## 4. Data model

### 4.1 Channel

A channel `c` is created once and its fields never change:

- `id`: unique within the ledger. An id is never reused, even after the channel closes.
- `payer`, `provider`, `lender`: non-empty party ids, with `payer ≠ provider`.
- `L = lenderPrincipal ≥ 0` and `D = payerDeposit ≥ 0`.
- `E = escrow = L + D`.
- `h_open`: the height of the `ChannelOpened` event.

### 4.2 Finalized state

`σ = (nonce, owed, root, h)`, where `owed` is the **cumulative** amount owed to
the provider and `h` is the height at which `σ` was recorded in the ledger.

Every channel starts with the implicit state `σ₀ = (0, 0, ⊥, h_open)`. A
recorded state must have `nonce ≥ 1`.

`latest(c)` is the most recently accepted finalized state of `c`. By the
monotonicity invariant (I4), this is also the state with the highest nonce and
the highest `owed`.

### 4.3 Events

The ledger is an append-only sequence of events `e₁, e₂, …`. Every event has
`channelId` and `height`.

| Event              | Extra fields                                                 |
| ------------------ | ------------------------------------------------------------ |
| `ChannelOpened`    | `payer, provider, lender, lenderPrincipal, payerDeposit`     |
| `StateFinalized`   | `nonce, cumulativeOwed, stateRoot`                           |
| `ReclaimInitiated` | `by`                                                         |
| `Reclaimed`        | `by`                                                         |

The event log is the **only** state. Every derived value, including channel
status, latest state, challenge and settlement, is a pure function of
`(params, event log)`, and replaying the log must reproduce it exactly.

### 4.4 Ledger rules

- **R1 (height order).** `height(eₖ₊₁) ≥ height(eₖ)`. Several events may share
  a height. An event below the current head is rejected with `HEIGHT_REGRESSION`.
- **R2 (atomicity).** An event is either fully applied or rejected. A rejected
  event leaves no trace.
- **R3 (immutability).** Accepted events are never modified or removed.
- **R4 (query height).** Status queries must use a height `≥ head`, where `head`
  is the height of the last accepted event.
- **R5 (common checks).** Before any event-specific rule, every event must have
  a known `type`, a non-empty `channelId` and a `height ≥ 0` (`INVALID_EVENT`),
  and must satisfy R1.

## 5. Channel states

`status(c, h)` for `h ≥ head` is evaluated top-down:

```
Closed       if a Reclaimed event for c has been accepted
Reclaimable  if a challenge started at s and h ≥ s + W
Challenge    if a challenge started at s and h <  s + W
Stale        if h ≥ latest(c).h + N
Open         otherwise
```

Notes:

- Stale and Reclaimable are reached purely by the passage of blocks. No event
  is needed to enter them.
- A channel that is Stale returns to Open if a newer finalized state is
  accepted before anyone initiates a reclaim. That state is genuine progress.
- Once a challenge has started, it is never cancelled and its deadline never
  moves (see §7).

```
Open ──N blocks──► Stale ──ReclaimInitiated──► Challenge ──W blocks──► Reclaimable ──Reclaimed──► Closed
```

| From        | Trigger                         | To          |
| ----------- | ------------------------------- | ----------- |
| (none)      | `ChannelOpened`                 | Open        |
| Open        | newer `StateFinalized`          | Open        |
| Open        | `N` blocks with no newer state  | Stale       |
| Stale       | newer `StateFinalized`          | Open        |
| Stale       | `ReclaimInitiated`              | Challenge   |
| Challenge   | newer `StateFinalized`          | Challenge (owed updated, deadline unchanged) |
| Challenge   | `W` blocks since initiation     | Reclaimable |
| Reclaimable | `Reclaimed`                     | Closed      |

Every other event is rejected with a typed error (§12).

## 6. Staleness rule

A channel is **stale at height `h`** if and only if

```
h ≥ latest(c).h + N
```

Here `latest(c).h` is the height at which the most recent finalized state was
recorded, or `h_open` if no state has been finalized. Staleness depends on
block height only.

Progress means the finalized state root advances, that is, a state with a
strictly higher nonce is accepted. A replayed, older or conflicting state is
rejected and therefore does not count as progress (§9).

## 7. Challenge window

**Initiation.** `ReclaimInitiated(c, h, by)` is accepted if and only if:

1. `c` exists and is not Closed (`UNKNOWN_CHANNEL`, `CHANNEL_CLOSED`);
2. no challenge has started for `c` (`CHALLENGE_ALREADY_STARTED`);
3. `by` is allowed by the trigger policy (`UNAUTHORIZED`, see §8);
4. `status(c, h) = Stale` (`NOT_STALE`).

When accepted, it records `challenge = (s = h, by, reclaimableAt = h + W)`.

**Window.** The challenge window is the `W` heights `[s, s + W − 1]`, inclusive
at both ends. During the window, anyone holding a newer finalized state
(normally the provider) may submit it as a `StateFinalized` event. If the
state passes the usual checks (§9), it replaces `latest(c)`. The channel stays
in Challenge and `reclaimableAt` does not change.

**Closing.** At `h ≥ s + W`, `StateFinalized` for `c` is rejected with
`CHALLENGE_WINDOW_CLOSED`. This freezes the settlement inputs before anyone can
execute the reclaim.

The last height at which the provider can submit is therefore `s + W − 1`. The
first height at which the channel can be reclaimed is `s + W`. A submission and
a reclaim can never land on the same height.

## 8. Who may trigger

`T = "channel-parties"` (default): `by ∈ {payer, provider, lender}`. All three
have a reason to trigger. The lender and payer want to recover escrow, and the
provider wants to be paid on a channel the payer has abandoned.

`T = "anyone"`: permissionless. This is safe because payouts (§10) are
independent of `by` and of the height at which the reclaim executes.

The same policy applies to both `ReclaimInitiated` and `Reclaimed`.

## 9. Accepting finalized states

`StateFinalized(c, h, nonce, owed, root)` is accepted if and only if all of the
following hold, checked in this order:

1. `c` exists and is not Closed (`UNKNOWN_CHANNEL`, `CHANNEL_CLOSED`).
2. The event is well-formed: `nonce ≥ 1`, `owed ≥ 0`, `root` is non-empty
   (`INVALID_EVENT`).
3. If a challenge exists, `h < s + W` (`CHALLENGE_WINDOW_CLOSED`).
4. `nonce ≥ latest.nonce`, otherwise the state is out of order or older
   (`STALE_NONCE`).
5. If `nonce = latest.nonce`:
   - identical `(root, owed)` is a replay (`STATE_REPLAYED`);
   - different content is equivocation (`CONFLICTING_STATE`).
6. `owed ≥ latest.owed` (`OWED_DECREASED`).
7. If `V` is configured, `V(channel, state) = true` (`STATE_REJECTED`).

Nonce gaps are allowed. Not every off-ledger state needs to be finalized.

`owed > E` is **accepted**. The channel records `overrun = owed − E`
immediately, and settlement caps the provider at `E` (§10). Rejecting such
states would let a payer deny payment for work it already signed for. Capping
them means no credit is ever minted.

## 10. Reclaim amount and payout ordering

**Execution.** `Reclaimed(c, h, by)` is accepted if and only if:

1. `c` exists (`UNKNOWN_CHANNEL`);
2. `c` has not settled (`ALREADY_SETTLED`);
3. a challenge exists (`NO_CHALLENGE`);
4. `h ≥ s + W` (`CHALLENGE_WINDOW_OPEN`);
5. `by` is allowed by the trigger policy (`UNAUTHORIZED`).

**Formula.** Let `O = latest(c).owed` at execution time, `E = escrow` and
`L = lenderPrincipal`:

```
reclaimable    = max(E − O, 0)                 // escrow recoverable away from the provider

toProvider     = min(O, E)                     // 1st: provider's owed amount
toLender       = min(L, E − toProvider)        // 2nd: lender principal
toPayer        = E − toProvider − toLender     // 3rd: remainder to payer

overrun        = O − toProvider                // recorded, not paid, not minted
lenderShortfall= L − toLender                  // recorded for the lender's books
```

Since `toLender + toPayer = reclaimable`, the payer's own deposit `D` is
consumed first (first-loss) and the lender is senior to the payer.

The settlement is recorded in the projection together with `nonce`, `owed`,
`escrow`, `height` and `by`. It does not depend on `h` or `by`.

## 11. Invariants

Let `𝓛` range over all event logs reachable by appending events. Each event in
the log is either accepted or rejected.

**I1 (Conservation).** For every settled channel `c`:

```
toProvider + toLender + toPayer = E_c        and   toProvider, toLender, toPayer ≥ 0
```

Summed over all settled channels, total payouts equal total settled escrow.
No credit is ever minted or burned.

**I2 (Provider safety).** For every settled channel, with `O* = latest(c).owed`
at settlement:

```
toProvider = min(O*, E_c)        toProvider + overrun = O*
O* ≤ E_c  ⇒  toProvider ≥ O*
∀ accepted StateFinalized σ of c:  toProvider ≥ min(σ.owed, E_c)
```

The provider is never paid less than the latest finalized state that was
recorded before the window closed. The only shortfall possible is `overrun`,
which is the part of `O*` that no escrow backs.

**I3 (No double-claim).** For every channel `c`, the log contains at most one
accepted `Reclaimed` event for `c`. No event for `c` is accepted after it. A
second reclaim attempt fails with `ALREADY_SETTLED`, and other events fail with
`CHANNEL_CLOSED`. Channel ids are never reused (`DUPLICATE_CHANNEL`), so a
closed channel's escrow cannot be claimed again under a fresh open.

**I4 (Monotonicity).** For the accepted `StateFinalized` events of `c`, taken
in log order:

```
nonce strictly increasing,   owed non-decreasing
```

Equivalently, `latest(c).nonce` and `latest(c).owed` never decrease.

**I5 (Liveness).** Take any reachable log with head `H` and any unsettled
channel `c` without a challenge. For every `h ≥ max(H, latest(c).h + N)`:

1. `ReclaimInitiated(c, h, lender)` is accepted.
2. For every valid extension of the log, `Reclaimed(c, h', lender)` is
   accepted at every `h' ≥ max(head, h + W)`. In particular, newer finalized
   states submitted during the window cannot delay it.

If no new progress arrives and the lender initiates promptly, the channel is
reclaimable at height `latest(c).h + N + W`. A channel that already has a
challenge is reclaimable at `reclaimableAt`. No action by the provider or the
payer can prevent either of these.

**I6 (Height order).** Accepted events have non-decreasing heights (R1).

**I7 (Atomicity and determinism).** A rejected event leaves the log and the
projection unchanged. `replay(params, log)` returns a projection equal to the
live one.

**I8 (Seniority).** `toLender > 0 ⇒ toProvider = O*`, and
`toPayer > 0 ⇒ toLender = L`.

## 12. Error codes

| Code                        | Raised when                                                            |
| --------------------------- | ---------------------------------------------------------------------- |
| `INVALID_PARAMS`            | `N < 1`, `W < 1`, unknown policy, or `V` is not a function.             |
| `INVALID_EVENT`             | Malformed event (non-bigint, negative, empty id, `payer = provider`, …). |
| `HEIGHT_REGRESSION`         | Event or query height is below the ledger head.                        |
| `UNKNOWN_CHANNEL`           | Event or query for a channel that was never opened.                    |
| `DUPLICATE_CHANNEL`         | `ChannelOpened` with an id already used.                               |
| `CHANNEL_CLOSED`            | Non-reclaim event for a settled channel.                               |
| `ALREADY_SETTLED`           | Second `Reclaimed` for a channel.                                      |
| `STALE_NONCE`               | `nonce < latest.nonce`.                                                |
| `STATE_REPLAYED`            | Exact copy of the latest state.                                        |
| `CONFLICTING_STATE`         | Same nonce as latest, different content.                               |
| `OWED_DECREASED`            | Higher nonce with lower cumulative owed.                               |
| `STATE_REJECTED`            | `verifyState` returned false.                                          |
| `NOT_STALE`                 | `ReclaimInitiated` while Open.                                         |
| `CHALLENGE_ALREADY_STARTED` | Second `ReclaimInitiated`.                                             |
| `NO_CHALLENGE`              | `Reclaimed` without a prior `ReclaimInitiated`.                        |
| `CHALLENGE_WINDOW_OPEN`     | `Reclaimed` before `s + W`.                                            |
| `CHALLENGE_WINDOW_CLOSED`   | `StateFinalized` at or after `s + W`.                                  |
| `UNAUTHORIZED`              | Caller is not allowed by the trigger policy.                           |

## 13. Design decisions and rationale

1. **Explicit initiation.** Staleness alone does not start the clock. Someone
   must append `ReclaimInitiated`. This gives the Stale state a meaning, since
   the provider can still resume freely while Stale. It also makes the
   challenge start an observable, auditable event.
2. **A challenge is sticky.** A newer state submitted during the window
   updates `owed` but neither reopens the channel nor extends the deadline.
   Otherwise a provider holding many signed states could submit them one at a
   time to block reclaim indefinitely.
3. **Hard window close.** States arriving at `h ≥ s + W` are rejected, even
   before anyone executes the reclaim. Settlement inputs are frozen at
   `s + W`, so payouts are the same no matter when or by whom the reclaim is
   executed.
4. **Overrun is accepted and capped.** See §9.
5. **Payer deposit is first-loss.** This follows the required ordering
   (provider, then lender, then payer). The payer's own deposit absorbs usage
   before lender principal does.
6. **Zero escrow is allowed.** It settles to all zeros, and any owed amount
   becomes overrun. It is harmless, and allowing it keeps I1 free of special
   cases.
7. **Global height order.** One ledger observes one chain, so heights are
   ordered across all channels, not only within a channel.
8. **No reclaim deadline.** Once Reclaimable, a channel stays reclaimable
   forever, and the payout does not change with time.
