import { ReclaimError } from "./errors.js";
import { computePayouts } from "./settlement.js";
import {
  ChannelStatus,
  type ChannelId,
  type ChannelOpened,
  type ChannelView,
  type Height,
  type LedgerEvent,
  type LedgerState,
  type PartyId,
  type ReclaimInitiated,
  type ReclaimParams,
  type Reclaimed,
  type StateFinalized,
} from "./types.js";

export const EMPTY_STATE: LedgerState = Object.freeze({
  head: null,
  channels: new Map<ChannelId, ChannelView>(),
});

const isBigint = (v: unknown): v is bigint => typeof v === "bigint";
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function validateParams(params: ReclaimParams): void {
  if (!isBigint(params.stalenessBlocks) || params.stalenessBlocks < 1n) {
    throw new ReclaimError("INVALID_PARAMS", "stalenessBlocks must be a bigint >= 1");
  }
  if (!isBigint(params.challengeWindowBlocks) || params.challengeWindowBlocks < 1n) {
    throw new ReclaimError("INVALID_PARAMS", "challengeWindowBlocks must be a bigint >= 1");
  }
  if (params.triggerPolicy !== "channel-parties" && params.triggerPolicy !== "anyone") {
    throw new ReclaimError("INVALID_PARAMS", "triggerPolicy must be 'channel-parties' or 'anyone'");
  }
  if (params.verifyState !== undefined && typeof params.verifyState !== "function") {
    throw new ReclaimError("INVALID_PARAMS", "verifyState must be a function when provided");
  }
}

/**
 * Status of a channel at `height`. Pure function of the channel projection;
 * callers must not pass a height below the height of the last event applied
 * to the channel (the ledger enforces this).
 */
export function statusAt(channel: ChannelView, height: Height, params: ReclaimParams): ChannelStatus {
  if (channel.settlement !== null) return ChannelStatus.Closed;
  if (channel.challenge !== null) {
    return height >= channel.challenge.reclaimableAt ? ChannelStatus.Reclaimable : ChannelStatus.Challenge;
  }
  return height >= channel.latest.height + params.stalenessBlocks ? ChannelStatus.Stale : ChannelStatus.Open;
}

/** Earliest height at which the channel may be reclaimed if nobody delays initiating it. */
export function earliestReclaimHeight(channel: ChannelView, params: ReclaimParams): Height | null {
  if (channel.settlement !== null) return null;
  if (channel.challenge !== null) return channel.challenge.reclaimableAt;
  return channel.latest.height + params.stalenessBlocks + params.challengeWindowBlocks;
}

/**
 * Pure transition function: validates `event` against `state` and returns the
 * next state, or throws a `ReclaimError`. Never mutates its inputs.
 */
export function applyEvent(state: LedgerState, event: LedgerEvent, params: ReclaimParams): LedgerState {
  if (event === null || typeof event !== "object") {
    throw new ReclaimError("INVALID_EVENT", "event must be an object");
  }
  if (!isNonEmptyString(event.channelId)) {
    throw new ReclaimError("INVALID_EVENT", "channelId must be a non-empty string");
  }
  if (!isBigint(event.height) || event.height < 0n) {
    throw new ReclaimError("INVALID_EVENT", "height must be a bigint >= 0", event.channelId);
  }
  if (state.head !== null && event.height < state.head) {
    throw new ReclaimError(
      "HEIGHT_REGRESSION",
      `event height ${event.height} is below ledger head ${state.head}`,
      event.channelId,
    );
  }

  let next: ChannelView;
  switch (event.type) {
    case "ChannelOpened":
      next = applyOpened(state, event);
      break;
    case "StateFinalized":
      next = applyFinalized(state, event, params);
      break;
    case "ReclaimInitiated":
      next = applyInitiated(state, event, params);
      break;
    case "Reclaimed":
      next = applyReclaimed(state, event, params);
      break;
    default:
      throw new ReclaimError(
        "INVALID_EVENT",
        `unknown event type ${String((event as { type?: unknown }).type)}`,
        (event as { channelId?: string }).channelId,
      );
  }

  const channels = new Map(state.channels);
  channels.set(event.channelId, Object.freeze(next));
  return Object.freeze({ head: event.height, channels });
}

export function replay(events: readonly LedgerEvent[], params: ReclaimParams): LedgerState {
  validateParams(params);
  let state = EMPTY_STATE;
  for (const event of events) state = applyEvent(state, event, params);
  return state;
}

function applyOpened(state: LedgerState, e: ChannelOpened): ChannelView {
  if (state.channels.has(e.channelId)) {
    throw new ReclaimError("DUPLICATE_CHANNEL", "channel id already used", e.channelId);
  }
  for (const key of ["payer", "provider", "lender"] as const) {
    if (!isNonEmptyString(e[key])) {
      throw new ReclaimError("INVALID_EVENT", `${key} must be a non-empty string`, e.channelId);
    }
  }
  if (e.payer === e.provider) {
    throw new ReclaimError("INVALID_EVENT", "payer and provider must differ", e.channelId);
  }
  for (const key of ["lenderPrincipal", "payerDeposit"] as const) {
    const v = e[key];
    if (!isBigint(v) || v < 0n) {
      throw new ReclaimError("INVALID_EVENT", `${key} must be a bigint >= 0`, e.channelId);
    }
  }
  return {
    channelId: e.channelId,
    payer: e.payer,
    provider: e.provider,
    lender: e.lender,
    lenderPrincipal: e.lenderPrincipal,
    payerDeposit: e.payerDeposit,
    escrow: e.lenderPrincipal + e.payerDeposit,
    openedAt: e.height,
    latest: Object.freeze({ nonce: 0n, cumulativeOwed: 0n, stateRoot: null, height: e.height }),
    overrun: 0n,
    challenge: null,
    settlement: null,
  };
}

function requireChannel(state: LedgerState, channelId: ChannelId): ChannelView {
  const channel = state.channels.get(channelId);
  if (channel === undefined) {
    throw new ReclaimError("UNKNOWN_CHANNEL", "channel was never opened", channelId);
  }
  return channel;
}

function requireOpenChannel(state: LedgerState, channelId: ChannelId): ChannelView {
  const channel = requireChannel(state, channelId);
  if (channel.settlement !== null) {
    throw new ReclaimError("CHANNEL_CLOSED", "channel has already settled", channelId);
  }
  return channel;
}

function requireAuthorized(channel: ChannelView, by: PartyId, params: ReclaimParams): void {
  if (!isNonEmptyString(by)) {
    throw new ReclaimError("INVALID_EVENT", "by must be a non-empty string", channel.channelId);
  }
  if (
    params.triggerPolicy === "channel-parties" &&
    by !== channel.payer &&
    by !== channel.provider &&
    by !== channel.lender
  ) {
    throw new ReclaimError("UNAUTHORIZED", "caller is not a party to the channel", channel.channelId);
  }
}

function applyFinalized(state: LedgerState, e: StateFinalized, params: ReclaimParams): ChannelView {
  const channel = requireOpenChannel(state, e.channelId);
  if (!isBigint(e.nonce) || e.nonce < 1n) {
    throw new ReclaimError("INVALID_EVENT", "nonce must be a bigint >= 1", e.channelId);
  }
  if (!isBigint(e.cumulativeOwed) || e.cumulativeOwed < 0n) {
    throw new ReclaimError("INVALID_EVENT", "cumulativeOwed must be a bigint >= 0", e.channelId);
  }
  if (!isNonEmptyString(e.stateRoot)) {
    throw new ReclaimError("INVALID_EVENT", "stateRoot must be a non-empty string", e.channelId);
  }
  if (channel.challenge !== null && e.height >= channel.challenge.reclaimableAt) {
    throw new ReclaimError(
      "CHALLENGE_WINDOW_CLOSED",
      `challenge window ended at height ${channel.challenge.reclaimableAt - 1n}`,
      e.channelId,
    );
  }

  const latest = channel.latest;
  if (e.nonce < latest.nonce) {
    throw new ReclaimError("STALE_NONCE", `nonce ${e.nonce} is below latest ${latest.nonce}`, e.channelId);
  }
  if (e.nonce === latest.nonce) {
    if (e.stateRoot === latest.stateRoot && e.cumulativeOwed === latest.cumulativeOwed) {
      throw new ReclaimError("STATE_REPLAYED", `state with nonce ${e.nonce} already recorded`, e.channelId);
    }
    throw new ReclaimError(
      "CONFLICTING_STATE",
      `different state for already recorded nonce ${e.nonce}`,
      e.channelId,
    );
  }
  if (e.cumulativeOwed < latest.cumulativeOwed) {
    throw new ReclaimError(
      "OWED_DECREASED",
      `cumulativeOwed ${e.cumulativeOwed} is below latest ${latest.cumulativeOwed}`,
      e.channelId,
    );
  }
  const input = { nonce: e.nonce, cumulativeOwed: e.cumulativeOwed, stateRoot: e.stateRoot };
  if (params.verifyState !== undefined && params.verifyState(channel, input) !== true) {
    throw new ReclaimError("STATE_REJECTED", "verifyState rejected the finalized state", e.channelId);
  }

  return {
    ...channel,
    latest: Object.freeze({ ...input, height: e.height }),
    overrun: e.cumulativeOwed > channel.escrow ? e.cumulativeOwed - channel.escrow : 0n,
  };
}

function applyInitiated(state: LedgerState, e: ReclaimInitiated, params: ReclaimParams): ChannelView {
  const channel = requireOpenChannel(state, e.channelId);
  if (channel.challenge !== null) {
    throw new ReclaimError(
      "CHALLENGE_ALREADY_STARTED",
      `challenge started at height ${channel.challenge.startedAt}`,
      e.channelId,
    );
  }
  requireAuthorized(channel, e.by, params);
  if (statusAt(channel, e.height, params) !== ChannelStatus.Stale) {
    throw new ReclaimError(
      "NOT_STALE",
      `channel becomes stale at height ${channel.latest.height + params.stalenessBlocks}`,
      e.channelId,
    );
  }
  return {
    ...channel,
    challenge: Object.freeze({
      startedAt: e.height,
      by: e.by,
      reclaimableAt: e.height + params.challengeWindowBlocks,
    }),
  };
}

function applyReclaimed(state: LedgerState, e: Reclaimed, params: ReclaimParams): ChannelView {
  const channel = requireChannel(state, e.channelId);
  if (channel.settlement !== null) {
    throw new ReclaimError(
      "ALREADY_SETTLED",
      `channel settled at height ${channel.settlement.height}`,
      e.channelId,
    );
  }
  if (channel.challenge === null) {
    throw new ReclaimError("NO_CHALLENGE", "reclaim requires a prior ReclaimInitiated", e.channelId);
  }
  if (e.height < channel.challenge.reclaimableAt) {
    throw new ReclaimError(
      "CHALLENGE_WINDOW_OPEN",
      `reclaimable at height ${channel.challenge.reclaimableAt}`,
      e.channelId,
    );
  }
  requireAuthorized(channel, e.by, params);

  const payouts = computePayouts({
    escrow: channel.escrow,
    lenderPrincipal: channel.lenderPrincipal,
    owed: channel.latest.cumulativeOwed,
  });
  return {
    ...channel,
    settlement: Object.freeze({
      channelId: channel.channelId,
      height: e.height,
      by: e.by,
      nonce: channel.latest.nonce,
      owed: channel.latest.cumulativeOwed,
      escrow: channel.escrow,
      ...payouts,
    }),
  };
}
