import { describe, expect, it } from "vitest";
import { computePayouts, reclaimableAmount } from "../src/index.js";

describe("computePayouts (waterfall)", () => {
  it("pays provider owed, then lender principal, then payer remainder", () => {
    expect(computePayouts({ escrow: 1000n, lenderPrincipal: 700n, owed: 200n })).toEqual({
      toProvider: 200n,
      toLender: 700n,
      toPayer: 100n,
      overrun: 0n,
      lenderShortfall: 0n,
    });
  });

  it("consumes the payer deposit before lender principal", () => {
    expect(computePayouts({ escrow: 1000n, lenderPrincipal: 700n, owed: 300n })).toMatchObject({
      toLender: 700n,
      toPayer: 0n,
      lenderShortfall: 0n,
    });
    expect(computePayouts({ escrow: 1000n, lenderPrincipal: 700n, owed: 450n })).toMatchObject({
      toProvider: 450n,
      toLender: 550n,
      toPayer: 0n,
      lenderShortfall: 150n,
    });
  });

  it("caps provider at escrow and records the overrun", () => {
    expect(computePayouts({ escrow: 1000n, lenderPrincipal: 700n, owed: 1250n })).toEqual({
      toProvider: 1000n,
      toLender: 0n,
      toPayer: 0n,
      overrun: 250n,
      lenderShortfall: 700n,
    });
  });

  it("handles amounts far beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const big = 10n ** 30n + 7n;
    const p = computePayouts({ escrow: big, lenderPrincipal: big - 3n, owed: 1n });
    expect(p.toProvider + p.toLender + p.toPayer).toBe(big);
    expect(p.toPayer).toBe(2n);
  });

  it("rejects inputs that violate its preconditions", () => {
    expect(() => computePayouts({ escrow: 10n, lenderPrincipal: 11n, owed: 0n })).toThrow(RangeError);
    expect(() => computePayouts({ escrow: 10n, lenderPrincipal: 1n, owed: -1n })).toThrow(RangeError);
    expect(() => computePayouts({ escrow: -1n, lenderPrincipal: 0n, owed: 0n })).toThrow(RangeError);
  });
});

describe("reclaimableAmount", () => {
  it("is escrow minus owed, floored at zero", () => {
    expect(reclaimableAmount(1000n, 200n)).toBe(800n);
    expect(reclaimableAmount(1000n, 1000n)).toBe(0n);
    expect(reclaimableAmount(1000n, 5000n)).toBe(0n);
    expect(reclaimableAmount(0n, 0n)).toBe(0n);
  });
});
