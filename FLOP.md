# How flop-channel-reclaim sits on FLOP

Source for every statement about FLOP below: the FLOP Network whitepaper,
<https://flop.network/whitepaper/> (draft dated 25 September 2026). The
whitepaper says the Yellow Paper is the definitive specification and that it
is not yet final. Items marked **[YP]** depend on it. Items marked
**Proposal** are our design suggestions, not FLOP facts.

IDs such as IF-F12 or IF-D8 refer to the Inference Finance product spec (an
EVM AMM for inference credits measured in OMER, rehearsed on HyperEVM testnet
with TEST mocks). Its contracts are not public, so this repo describes them
only at the level of that spec.

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
| `StateFinalized` as evidence of spend | **Proposal:** a candidate Flop spend receipt. A commitment to finalized channel states (channel, nonce, cumulative owed) could serve as the receipt root behind an EVM hook's `jobId` (open decision IF-D8) and as the settler-attested spend that earns rewards (IF-F11), each receipt counted once. |
| `ReclaimInitiated` → `Reclaimed` | **Proposal:** the timing and payout order for the "reclaimed if unserved" path of a receipt-backed credit minter (IF-F12): no progress for `N` blocks, a `W`-block window, then provider owed first, lender principal next, payer remainder last, never minting. |

## 3. Where it runs

**Role:** an independent off-chain reference implementation and test-vector
source for Inference Finance, whose AMM is Solidity on HyperEVM testnet (chain
998), unaudited and TEST mocks only. FLOP has no EVM and no user-deployed code,
so DeFi contracts run on an EVM chain and integrate with FLOP through inference
credits, spend receipts, escrow and channels. A native FLOP module remains a
possible long-term path, not the current plan.

The logic is pure and replayable (`replay(params, events)`), with no clocks or
I/O, so agents, a venue such as Technocore, or a contract's test suite can
check a reclaim against it. On FLOP, funds move only through native escrow and
time-lock primitives.

**Honest gap:** there is still no on-chain FLOP or Pearl inference-credit
token, so the EVM side can only model these receipts and reclaims with TEST
mocks today.

## 4. Money legos

- **Flop reclaim (this repo):** bounds what a lender can lose in a stale
  channel and fixes who is paid first.
- **StableSwap pool** ([inferencefi-stableswap](https://github.com/HuKiFl1/inferencefi-stableswap)):
  a pool coin can be backed by channel escrow. The pool caps its holdings at
  this package's `toLender` (exported there as `recoverablePrincipal`), and
  its backing events mirror `StateFinalized` / `ReclaimInitiated` /
  `Reclaimed`.
- **Receipt-backed credit (Proposal):** finalized channel states are a
  candidate spend receipt for Inference Finance's rewards and hook attribution
  (IF-F11, IF-D8), and this package's reclaim rule maps onto its minter's
  "reclaimed if unserved" redemption (IF-F12).
- **FCU term tape (later):** settled FLOP Compute Unit reservations form the
  "transaction-anchored term tape" the whitepaper describes (§12). FCUs are
  ratified protocol design with implementation planned after the core
  protocol. Reclaimed or stale channels are a credit signal such a curve or a
  future credit line could consume.

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
   trigger"?
3. **Partial reclaim policy.** TCLK's refund returns everything to the
   creator. This package splits escrow three ways (provider owed, lender
   principal, payer remainder). Is a three-way split expressible as a typed
   escrow release policy, or must it be enforced off-chain or on the EVM side?
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
