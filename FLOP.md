# How flop-channel-reclaim sits on FLOP

Source for every statement about FLOP below: the FLOP Network whitepaper,
<https://flop.network/whitepaper/> (draft dated 25 September 2026). The
whitepaper says the Yellow Paper is the definitive specification and that it
is not yet final. Items marked **[YP]** depend on it. Items marked
**Proposal** are our design suggestions, not FLOP facts.

## 1. What FLOP provides (whitepaper facts)

- FLOP is its own Layer 1 built on Substrate. It has **no EVM and is
  deliberately not Turing-complete**. General computation runs off-chain,
  inside the agent, and settles on-chain through a small set of fixed, audited
  primitives: transfers, staking, escrow, time locks, multi-signature and
  spend conditions (§03 Design principles).
- Finality is AlephBFT: once a block is ordered it is irreversible (§03).
- The unit of work is a **session**: one agent request served by one miner
  and settled through a **compute channel**. Payment channels carry the
  per-call traffic, so chain load scales with sessions, not calls (§03,
  Glossary). The whitepaper says payment settles per block through the compute
  channel; its own header notes that per-block settlement still differs from
  the Yellow Paper **[YP]**.
- Accounts support multisig, timelock/vesting, multi-party pool /
  collaborative escrow, a declarative spend-condition layer and pre-set spend
  limits (§02).
- The native settlement primitive is the **HTLC**, implemented as the
  Technocore Lock Protocol (**TCLK**). A deal goes offer → accept → lock →
  reveal or refund. The creator can request a refund once the finalized FLOP
  prefix reaches the deadline. **A timeout enables refund but does not expire
  a hashlock claim: the first included terminal transition wins** (§11).
- The on-chain escrow evaluates composable release policies: hash, point,
  signature and time conditions combined with and / or / threshold (§11).
- New functionality arrives **as audited native modules adopted through
  governance, never as user-deployed code**, via FIPs approved by validators
  with an enactment delay (§03 Upgrades, §09).
- Technocore (technocore.chat) is the venue where agents meet, agree work and
  lock against it; it records agreements and settles nothing (§10, §11).
  Agents are identified by self-generated, self-signed DIDs (§03, §10).

## 2. Mapping

| This package | FLOP primitive it maps to |
|---|---|
| Channel (`ChannelOpened`) | A compute channel carrying a session's payments, funded into FLOP escrow. |
| `lenderPrincipal` + `payerDeposit` | Multi-party pool / collaborative escrow (§02). **Proposal:** a lender co-funding the escrow is an InferenceFi addition; the whitepaper describes no lender role. |
| `StateFinalized` (nonce, cumulative owed) | The latest co-signed channel state. How channel states are signed and finalized is **[YP]**. |
| `stalenessBlocks` `N` | A time condition in the escrow's release policy. |
| `ReclaimInitiated` + `challengeWindowBlocks` `W` | A time lock: the refund-style path that opens once the finalized prefix passes `s + W`. |
| `Reclaimed` payout waterfall | An escrow release to provider, lender and payer under a spend condition. |
| Block heights | Finalized FLOP heights. AlephBFT finality means no reorg handling is needed; the library already assumes callers feed final heights. |

## 3. Where it runs

The logic is pure and replayable (`replay(params, events)`), with no clocks or
I/O. It runs **off-chain**, inside agents or in a venue such as Technocore,
where parties can check a reclaim before anyone submits a transaction. Funds
move only through FLOP's native escrow and time-lock primitives.

**Proposal:** this repository is a reference specification plus test suite
for a governance-adopted native module (a Substrate pallet) that would enforce
the same rule at the escrow layer. It is not an EVM contract and not
user-deployed code; FLOP has neither.

## 4. Money legos

- **Flop reclaim (this repo):** bounds what a lender can lose in a stale
  channel and fixes who is paid first.
- **StableSwap pool** ([inferencefi-stableswap](https://github.com/HuKiFl1/inferencefi-stableswap)):
  a pool coin can be backed by channel escrow. The pool caps its holdings at
  this package's `toLender` (exported there as `recoverablePrincipal`), and
  its backing events mirror `StateFinalized` / `ReclaimInitiated` /
  `Reclaimed`.
- **Oracle and FCU forward curve (in progress, Proposal):** a price oracle
  over pool prices plus a 1–30 day forward curve read from settled FLOP
  Compute Unit reservations, the "transaction-anchored term tape" the
  whitepaper describes (§12). FCUs are ratified protocol design with
  implementation planned after the core protocol. Reclaimed or stale channels
  are a credit signal such a curve or a future credit line could consume.

## 5. Divergences from TCLK and open questions

The code is unchanged; these are questions for the protocol authors.

1. **Hard window close vs. "timeout does not expire a claim".** TCLK lets a
   hashlock claim succeed after the deadline until a refund is actually
   included. This package rejects any newer `StateFinalized` at `h ≥ s + W`,
   even before `Reclaimed` is executed (SPEC §7, §13.3), so payouts are fixed
   regardless of who reclaims or when. Should a channel reclaim follow TCLK's
   first-terminal-transition-wins rule instead?
2. **Relative vs. absolute deadline.** A TCLK lock carries its deadline from
   the start. Here the deadline only exists after explicit initiation
   (`s + W`), following `N` blocks without progress. Can FLOP's time
   conditions express "N blocks since the last state, then W blocks after a
   trigger", or does this need native module support?
3. **Partial reclaim policy.** TCLK's refund returns everything to the
   creator. This package splits escrow three ways (provider owed, lender
   principal, payer remainder). Is a three-way split expressible as a typed
   escrow release policy, or does it need the module?
4. **Per-block settlement [YP].** If the compute channel pays the miner every
   block, "owed" is mostly already paid and the reclaim amount is the
   unspent remainder. How cumulative channel states and per-block payouts
   interact is a Yellow Paper question.
5. **Finalized heights.** The library assumes heights are finalized. With
   AlephBFT that is the ordered height; please confirm.
6. **Slashing overlap [YP].** A miner is slashed for accepting a session and
   failing to deliver it (§04). Should a stale channel where the miner stopped
   serving feed that process, or stay a purely economic reclaim? The header
   notes slashing for non-delivery still differs from the Yellow Paper.
