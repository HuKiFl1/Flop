# flop-channel-reclaim

A small, deterministic TypeScript library that specifies and enforces the
**escrow reclaim (liquidation) rule for stale paid-compute payment channels**.

The setting is an inference-credit protocol. A lender or pool escrows credit
into a payer↔provider channel, the payer (an agent) buys inference from the
provider (a miner), and the parties finalize cumulative "amount owed" states
with increasing nonces. If finalized states stop advancing, this library
decides:

- **when** the escrow can be reclaimed: after `N` blocks without progress, plus
  a `W`-block challenge window;
- **how much** can be reclaimed: `max(escrow − owed, 0)`;
- **who receives it**: the provider's owed amount first, then the lender's
  principal, then the remainder to the payer;

and guarantees that the provider is never paid less than the latest finalized
state, that nobody can double-claim, and that no credit is ever minted.

The full rules and formal invariants are in **[SPEC.md](./SPEC.md)**.

## How this sits on FLOP

FLOP is a Substrate Layer 1 with no EVM and no user-deployed code. General
computation runs off-chain inside agents and settles through fixed native
primitives: transfers, staking, escrow, time locks, multisig and spend
conditions ([whitepaper](https://flop.network/whitepaper/), §03).

- **Builds on:** FLOP compute channels (one session, settled through a
  channel), collaborative escrow, and time locks. Staleness `N` and the
  challenge window `W` are time conditions, and the payout waterfall is an
  escrow release. Refund-after-deadline follows the same pattern as TCLK, the
  HTLC used by agents on Technocore.
- **Runs off-chain:** the rule is pure and replayable, so agents, or a venue
  such as Technocore, can check a reclaim before settling it on FLOP.
- **Proposal:** a reference spec and test suite for a governance-adopted
  native module (pallet). It is not an EVM contract.
- **Money legos:** it caps what the
  [StableSwap pool](https://github.com/HuKiFl1/inferencefi-stableswap) may
  hold of an escrow-backed coin, and it feeds the upcoming oracle and FCU
  forward curve.

Details, including where this rule differs from TCLK (a hard window close vs.
"a timeout does not expire a claim"), are in **[FLOP.md](./FLOP.md)**.

## Properties

- Node 20+, ESM, **zero runtime dependencies**.
- All amounts and heights are `bigint`. No floats, no clocks, no I/O. You pass
  the block height in.
- The **append-only event log is the only state**. Channel projections are a
  pure function of `(params, events)`, and `replay` rebuilds them exactly.
- Invalid transitions throw a `ReclaimError` with a stable, typed `code`.
  Appends are atomic, so a rejected event leaves no trace.

## Usage

```ts
import { ReclaimLedger, ChannelStatus, isReclaimError } from "flop-channel-reclaim";

const ledger = new ReclaimLedger({
  stalenessBlocks: 100n,      // N
  challengeWindowBlocks: 20n, // W
  triggerPolicy: "channel-parties",
  // verifyState: (channel, state) => checkCoSignature(channel, state),
});

ledger.append({
  type: "ChannelOpened", channelId: "ch-1", height: 1_000n,
  payer: "agent", provider: "miner", lender: "pool",
  lenderPrincipal: 900_000n, payerDeposit: 100_000n,
});
ledger.append({
  type: "StateFinalized", channelId: "ch-1", height: 1_010n,
  nonce: 1n, cumulativeOwed: 250_000n, stateRoot: "0xabc",
});

ledger.status("ch-1", 1_110n); // "Stale"
ledger.append({ type: "ReclaimInitiated", channelId: "ch-1", height: 1_110n, by: "pool" });

// The provider may still submit a newer state up to height 1_129.
ledger.append({
  type: "StateFinalized", channelId: "ch-1", height: 1_129n,
  nonce: 2n, cumulativeOwed: 300_000n, stateRoot: "0xdef",
});

try {
  ledger.append({ type: "Reclaimed", channelId: "ch-1", height: 1_129n, by: "pool" });
} catch (e) {
  if (isReclaimError(e, "CHALLENGE_WINDOW_OPEN")) { /* wait for height 1_130 */ }
}

const { settlement } = ledger.append({ type: "Reclaimed", channelId: "ch-1", height: 1_130n, by: "pool" });
// settlement: toProvider 300_000n, toLender 700_000n, toPayer 0n, overrun 0n, lenderShortfall 200_000n
ledger.status("ch-1", 1_130n) === ChannelStatus.Closed; // true
```

Lower-level pure functions are also exported: `applyEvent`, `replay`,
`statusAt`, `computePayouts`, `reclaimableAmount` and `earliestReclaimHeight`.

## Development

```sh
npm install
npm test            # vitest: unit, edge-case and property-based tests
npm run typecheck   # tsc --noEmit (strict)
npm run build       # emits dist/
```

To run more property-test iterations, set `PROPERTY_RUNS`, for example
`PROPERTY_RUNS=5000 npm test`.

Test layout:

- `tests/transitions.test.ts`: every transition and every rejection code.
- `tests/edge-cases.test.ts`: zero escrow, owed = escrow, owed > escrow
  (overrun), a challenge on the last block of the window, replayed states,
  out-of-order nonces, a double reclaim, and heights going backwards.
- `tests/invariants.property.test.ts`: fast-check over random multi-channel
  event sequences, which include backwards heights, replays, conflicting
  states and unauthorized callers. It asserts conservation, provider safety,
  no double-claim, monotonicity, liveness (against an adversarial provider),
  seniority, height order, atomicity and replay determinism after every step.
  A coverage guard ensures the generator reaches every status and every
  rejection class.
- `tests/settlement.test.ts`: the payout waterfall.

## Open questions for the protocol author

These are assumptions built into v0.1 that need confirmation. Each one is a
small, local change in `src/machine.ts` or `src/settlement.ts`.

1. **`N` and `W` values.** What staleness and window lengths should FLOP use?
   Should they be global, per pool, or per channel? Should heights be
   *finalized* heights, so that reorgs cannot move a channel back out of
   Reclaimable? This library assumes the caller only feeds it final heights.
2. **What "finalized" means.** The library assumes a state is finalized when it
   is recorded in the ledger, and it delegates authenticity (for example a
   payer+provider co-signature over `stateRoot`) to the optional `verifyState`
   hook. Is a payer-only signed voucher enough?
3. **Who can trigger.** The default allows the payer, provider and lender.
   `"anyone"` is supported and safe because payouts do not depend on the
   caller. Should there be a keeper bounty, and who would pay it?
4. **Does a newer state during the challenge reopen the channel?** v0.1 says no:
   it updates `owed` and the deadline stays fixed, which prevents griefing by
   dripping states one at a time. The alternative is that a newer state cancels
   the challenge and returns the channel to Open.
5. **What counts as progress?** Any higher nonce resets staleness, even with an
   unchanged `owed`. Should progress require a strictly higher `owed`? Before a
   challenge starts, a provider holding `k` unsubmitted signed states can delay
   staleness by up to `k·N` blocks.
6. **Partial settlements, top-ups and withdrawals** are not modelled. Escrow is
   fixed at open and settles exactly once. Do mid-life partial settlements to
   the provider exist? If so, they need their own conservation accounting.
7. **Cooperative close** for non-stale channels is out of scope here. Should it
   share this ledger?
8. **Overrun policy.** States with `owed > escrow` are accepted, recorded and
   capped. The provider bears the unbacked part. Should the protocol forbid
   signing such states, or penalize the payer for them?
9. **Lender interest and fees.** Only principal is repaid. Where do interest
   and protocol fees sit in the waterfall?
10. **Payer deposit is first-loss** (junior to the lender). Please confirm.
11. **Equivocation** (two different states with the same nonce) is rejected
    with `CONFLICTING_STATE`, but nothing else happens. Should it freeze the
    channel or slash someone?
12. **Zero-escrow channels** are allowed and settle to zero. Should they be
    rejected at open instead?
13. **Party constraints.** Only `payer ≠ provider` is enforced. Can the lender
    be the payer (self-funded) or the provider?
14. **No reclaim expiry.** A Reclaimable channel stays claimable forever. Is a
    sweep deadline needed?

## License

MIT. See [LICENSE](./LICENSE).
