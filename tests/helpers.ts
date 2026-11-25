import { expect } from "vitest";
import {
  ReclaimError,
  ReclaimLedger,
  type ChannelOpened,
  type ReclaimErrorCode,
  type ReclaimInitiated,
  type ReclaimParams,
  type Reclaimed,
  type StateFinalized,
} from "../src/index.js";

export const N = 10n;
export const W = 5n;

export const PARAMS: ReclaimParams = {
  stalenessBlocks: N,
  challengeWindowBlocks: W,
  triggerPolicy: "channel-parties",
};

export const CH = "channel-a";

export function opened(overrides: Partial<ChannelOpened> = {}): ChannelOpened {
  return {
    type: "ChannelOpened",
    channelId: CH,
    height: 100n,
    payer: "payer",
    provider: "provider",
    lender: "lender",
    lenderPrincipal: 700n,
    payerDeposit: 300n,
    ...overrides,
  };
}

export function finalized(
  nonce: bigint,
  cumulativeOwed: bigint,
  height: bigint,
  overrides: Partial<StateFinalized> = {},
): StateFinalized {
  return {
    type: "StateFinalized",
    channelId: CH,
    height,
    nonce,
    cumulativeOwed,
    stateRoot: `root-${nonce}-${cumulativeOwed}`,
    ...overrides,
  };
}

export function initiated(height: bigint, by = "lender", channelId = CH): ReclaimInitiated {
  return { type: "ReclaimInitiated", channelId, height, by };
}

export function reclaimed(height: bigint, by = "lender", channelId = CH): Reclaimed {
  return { type: "Reclaimed", channelId, height, by };
}

export function ledgerWith(...events: Parameters<ReclaimLedger["append"]>[0][]): ReclaimLedger {
  return ReclaimLedger.fromEvents(PARAMS, events);
}

export function expectCode(fn: () => unknown, code: ReclaimErrorCode): ReclaimError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ReclaimError ${code}`).toBeInstanceOf(ReclaimError);
  expect((caught as ReclaimError).code).toBe(code);
  return caught as ReclaimError;
}

/** Asserts that a rejected append left the ledger byte-for-byte unchanged. */
export function expectRejectedAtomically(
  ledger: ReclaimLedger,
  event: Parameters<ReclaimLedger["append"]>[0],
  code: ReclaimErrorCode,
): void {
  const before = ledger.state;
  const eventsBefore = ledger.events.length;
  expectCode(() => ledger.append(event), code);
  expect(ledger.state).toBe(before);
  expect(ledger.events.length).toBe(eventsBefore);
}
