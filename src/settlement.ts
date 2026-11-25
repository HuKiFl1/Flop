import type { Amount } from "./types.js";

export interface PayoutInput {
  readonly escrow: Amount;
  readonly lenderPrincipal: Amount;
  readonly owed: Amount;
}

export interface Payouts {
  readonly toProvider: Amount;
  readonly toLender: Amount;
  readonly toPayer: Amount;
  readonly overrun: Amount;
  readonly lenderShortfall: Amount;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/**
 * Waterfall: provider owed amount first, then lender principal, then the
 * remainder to the payer. Requires 0 <= lenderPrincipal <= escrow and owed >= 0.
 */
export function computePayouts({ escrow, lenderPrincipal, owed }: PayoutInput): Payouts {
  if (escrow < 0n || owed < 0n || lenderPrincipal < 0n || lenderPrincipal > escrow) {
    throw new RangeError("computePayouts: require 0 <= lenderPrincipal <= escrow and owed >= 0");
  }
  const toProvider = min(owed, escrow);
  const afterProvider = escrow - toProvider;
  const toLender = min(lenderPrincipal, afterProvider);
  const toPayer = afterProvider - toLender;
  return {
    toProvider,
    toLender,
    toPayer,
    overrun: owed - toProvider,
    lenderShortfall: lenderPrincipal - toLender,
  };
}

/** Escrow that can be reclaimed away from the provider: max(escrow - owed, 0). */
export function reclaimableAmount(escrow: Amount, owed: Amount): Amount {
  return max(escrow - owed, 0n);
}
