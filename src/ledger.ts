import { ReclaimError } from "./errors.js";
import { EMPTY_STATE, applyEvent, earliestReclaimHeight, statusAt, validateParams } from "./machine.js";
import { reclaimableAmount } from "./settlement.js";
import type {
  Amount,
  ChannelId,
  ChannelStatus,
  ChannelView,
  Height,
  LedgerEvent,
  LedgerState,
  ReclaimParams,
  Settlement,
} from "./types.js";

export type AppendResult =
  | { readonly ok: true; readonly event: LedgerEvent; readonly channel: ChannelView }
  | { readonly ok: false; readonly error: ReclaimError };

/**
 * Append-only event ledger. The event list is the only source of truth; the
 * channel projections are a cache that can always be rebuilt with `replay`.
 * Appends are atomic: a rejected event leaves the ledger untouched.
 */
export class ReclaimLedger {
  readonly params: ReclaimParams;
  #events: LedgerEvent[] = [];
  #state: LedgerState = EMPTY_STATE;

  constructor(params: ReclaimParams) {
    validateParams(params);
    this.params = Object.freeze({ ...params });
  }

  /** Rebuilds a ledger from a recorded event log, re-validating every event. */
  static fromEvents(params: ReclaimParams, events: readonly LedgerEvent[]): ReclaimLedger {
    const ledger = new ReclaimLedger(params);
    for (const event of events) ledger.append(event);
    return ledger;
  }

  /** Validates and records `event`, or throws a `ReclaimError` without changing state. */
  append(event: LedgerEvent): ChannelView {
    const frozen = Object.freeze({ ...event }) as LedgerEvent;
    const next = applyEvent(this.#state, frozen, this.params);
    this.#events.push(frozen);
    this.#state = next;
    return next.channels.get(frozen.channelId) as ChannelView;
  }

  /** Like `append`, but returns a result instead of throwing `ReclaimError`. */
  tryAppend(event: LedgerEvent): AppendResult {
    try {
      const channel = this.append(event);
      return { ok: true, event: this.#events[this.#events.length - 1] as LedgerEvent, channel };
    } catch (error) {
      if (error instanceof ReclaimError) return { ok: false, error };
      throw error;
    }
  }

  get events(): readonly LedgerEvent[] {
    return this.#events.slice();
  }

  get head(): Height | null {
    return this.#state.head;
  }

  get state(): LedgerState {
    return this.#state;
  }

  channel(channelId: ChannelId): ChannelView | undefined {
    return this.#state.channels.get(channelId);
  }

  channels(): ChannelView[] {
    return [...this.#state.channels.values()];
  }

  /** Channel status at `height`, which must not be below the ledger head. */
  status(channelId: ChannelId, height: Height): ChannelStatus {
    const channel = this.#requireChannel(channelId);
    this.#requireHeight(height, channelId);
    return statusAt(channel, height, this.params);
  }

  settlement(channelId: ChannelId): Settlement | null {
    return this.#requireChannel(channelId).settlement;
  }

  /** max(escrow - owed_latest, 0): what the lender and payer can recover between them. */
  reclaimable(channelId: ChannelId): Amount {
    const channel = this.#requireChannel(channelId);
    return reclaimableAmount(channel.escrow, channel.latest.cumulativeOwed);
  }

  /** Earliest height at which `Reclaimed` can succeed, assuming prompt initiation. */
  earliestReclaimHeight(channelId: ChannelId): Height | null {
    return earliestReclaimHeight(this.#requireChannel(channelId), this.params);
  }

  #requireChannel(channelId: ChannelId): ChannelView {
    const channel = this.#state.channels.get(channelId);
    if (channel === undefined) {
      throw new ReclaimError("UNKNOWN_CHANNEL", "channel was never opened", channelId);
    }
    return channel;
  }

  #requireHeight(height: Height, channelId: ChannelId): void {
    if (typeof height !== "bigint" || height < 0n) {
      throw new ReclaimError("INVALID_EVENT", "height must be a bigint >= 0", channelId);
    }
    if (this.#state.head !== null && height < this.#state.head) {
      throw new ReclaimError(
        "HEIGHT_REGRESSION",
        `query height ${height} is below ledger head ${this.#state.head}`,
        channelId,
      );
    }
  }
}
