import type { ChannelId } from "./types.js";

export type ReclaimErrorCode =
  /** Ledger parameters are malformed. */
  | "INVALID_PARAMS"
  /** Event is structurally malformed (wrong types, negative amounts, empty ids, ...). */
  | "INVALID_EVENT"
  /** Event height is lower than the ledger head, or a query height is below the head. */
  | "HEIGHT_REGRESSION"
  | "UNKNOWN_CHANNEL"
  /** A channel id was opened twice. Ids are never reused, even after close. */
  | "DUPLICATE_CHANNEL"
  /** Non-reclaim event for a channel that has already settled. */
  | "CHANNEL_CLOSED"
  /** Second reclaim of an already settled channel (double-claim attempt). */
  | "ALREADY_SETTLED"
  /** Finalized state nonce is lower than the latest accepted nonce. */
  | "STALE_NONCE"
  /** Exact copy of the latest accepted finalized state. */
  | "STATE_REPLAYED"
  /** Same nonce as the latest accepted state but different content (equivocation). */
  | "CONFLICTING_STATE"
  /** Higher nonce but lower cumulative owed amount. */
  | "OWED_DECREASED"
  /** `verifyState` hook returned false. */
  | "STATE_REJECTED"
  /** Reclaim initiated before the channel is Stale. */
  | "NOT_STALE"
  | "CHALLENGE_ALREADY_STARTED"
  /** Reclaim executed without a prior `ReclaimInitiated`. */
  | "NO_CHALLENGE"
  /** Reclaim executed before the challenge window has elapsed. */
  | "CHALLENGE_WINDOW_OPEN"
  /** Finalized state submitted after the challenge window has elapsed. */
  | "CHALLENGE_WINDOW_CLOSED"
  /** Caller not permitted by the trigger policy. */
  | "UNAUTHORIZED";

export class ReclaimError extends Error {
  override readonly name = "ReclaimError";
  readonly code: ReclaimErrorCode;
  readonly channelId: ChannelId | undefined;

  constructor(code: ReclaimErrorCode, message: string, channelId?: ChannelId) {
    super(`${code}: ${message}`);
    this.code = code;
    this.channelId = channelId;
  }
}

export function isReclaimError(value: unknown, code?: ReclaimErrorCode): value is ReclaimError {
  return value instanceof ReclaimError && (code === undefined || value.code === code);
}
