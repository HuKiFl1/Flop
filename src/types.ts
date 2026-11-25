/** Amount of credit in the smallest indivisible unit. Never a float. */
export type Amount = bigint;
/** Block height. Time in this library is measured only in blocks. */
export type Height = bigint;
/** Opaque party identifier (address, account id, ...). */
export type PartyId = string;
/** Opaque, ledger-unique channel identifier. Never reused. */
export type ChannelId = string;

export const ChannelStatus = {
  Open: "Open",
  Stale: "Stale",
  Challenge: "Challenge",
  Reclaimable: "Reclaimable",
  Closed: "Closed",
} as const;
export type ChannelStatus = (typeof ChannelStatus)[keyof typeof ChannelStatus];

/**
 * Who may append `ReclaimInitiated` and `Reclaimed` events.
 * - `channel-parties`: only the channel's payer, provider or lender.
 * - `anyone`: permissionless. Safe because payouts never depend on the caller.
 */
export type TriggerPolicy = "channel-parties" | "anyone";

export interface FinalizedStateInput {
  readonly nonce: bigint;
  readonly cumulativeOwed: Amount;
  readonly stateRoot: string;
}

export interface ReclaimParams {
  /** N: blocks without a newer finalized state after which a channel is Stale. Must be >= 1. */
  readonly stalenessBlocks: bigint;
  /** W: length of the challenge window in blocks. Must be >= 1. */
  readonly challengeWindowBlocks: bigint;
  readonly triggerPolicy: TriggerPolicy;
  /**
   * Optional authenticity check for finalized states (e.g. verify the
   * payer/provider co-signature over `stateRoot`). Must be pure and
   * deterministic; it is re-run on replay.
   */
  readonly verifyState?: (channel: ChannelView, state: FinalizedStateInput) => boolean;
}

export interface ChannelOpened {
  readonly type: "ChannelOpened";
  readonly channelId: ChannelId;
  readonly height: Height;
  readonly payer: PartyId;
  readonly provider: PartyId;
  readonly lender: PartyId;
  /** Credit escrowed by the lender/pool. Repaid with priority over the payer. */
  readonly lenderPrincipal: Amount;
  /** Credit escrowed by the payer. First-loss: consumed before lender principal. */
  readonly payerDeposit: Amount;
}

export interface StateFinalized extends FinalizedStateInput {
  readonly type: "StateFinalized";
  readonly channelId: ChannelId;
  readonly height: Height;
}

export interface ReclaimInitiated {
  readonly type: "ReclaimInitiated";
  readonly channelId: ChannelId;
  readonly height: Height;
  readonly by: PartyId;
}

export interface Reclaimed {
  readonly type: "Reclaimed";
  readonly channelId: ChannelId;
  readonly height: Height;
  readonly by: PartyId;
}

export type LedgerEvent = ChannelOpened | StateFinalized | ReclaimInitiated | Reclaimed;
export type LedgerEventType = LedgerEvent["type"];

export interface FinalizedState {
  /** 0 means "no state finalized since open". */
  readonly nonce: bigint;
  /** Cumulative amount owed to the provider. 0 at open. */
  readonly cumulativeOwed: Amount;
  /** `null` only for the implicit opening state (nonce 0). */
  readonly stateRoot: string | null;
  /** Height at which this state was recorded in the ledger. */
  readonly height: Height;
}

export interface Challenge {
  readonly startedAt: Height;
  readonly by: PartyId;
  /** First height at which the channel is Reclaimable: startedAt + W. */
  readonly reclaimableAt: Height;
}

export interface Settlement {
  readonly channelId: ChannelId;
  readonly height: Height;
  readonly by: PartyId;
  readonly nonce: bigint;
  readonly owed: Amount;
  readonly escrow: Amount;
  readonly toProvider: Amount;
  readonly toLender: Amount;
  readonly toPayer: Amount;
  /** Owed amount not covered by escrow. Recorded, never paid, never minted. */
  readonly overrun: Amount;
  /** Lender principal not recovered. Recorded for the lender/pool's books. */
  readonly lenderShortfall: Amount;
}

export interface ChannelView {
  readonly channelId: ChannelId;
  readonly payer: PartyId;
  readonly provider: PartyId;
  readonly lender: PartyId;
  readonly lenderPrincipal: Amount;
  readonly payerDeposit: Amount;
  /** lenderPrincipal + payerDeposit. Fixed at open. */
  readonly escrow: Amount;
  readonly openedAt: Height;
  readonly latest: FinalizedState;
  /** max(latest.cumulativeOwed - escrow, 0). Non-zero means the payer overspent its escrow. */
  readonly overrun: Amount;
  readonly challenge: Challenge | null;
  readonly settlement: Settlement | null;
}

export interface LedgerState {
  /** Height of the last accepted event, or null for an empty ledger. */
  readonly head: Height | null;
  readonly channels: ReadonlyMap<ChannelId, ChannelView>;
}
