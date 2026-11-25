import { describe, expect, it } from "vitest";
import { ChannelStatus } from "../src/index.js";
import {
  CH,
  N,
  W,
  expectCode,
  expectRejectedAtomically,
  finalized,
  initiated,
  ledgerWith,
  opened,
  reclaimed,
} from "./helpers.js";

const sumPayouts = (s: { toProvider: bigint; toLender: bigint; toPayer: bigint }) =>
  s.toProvider + s.toLender + s.toPayer;

describe("zero-escrow channel", () => {
  it("opens, goes stale, and settles to all-zero payouts", () => {
    const ledger = ledgerWith(opened({ lenderPrincipal: 0n, payerDeposit: 0n }));
    expect(ledger.channel(CH)!.escrow).toBe(0n);
    expect(ledger.reclaimable(CH)).toBe(0n);
    ledger.append(initiated(100n + N));
    const s = ledger.append(reclaimed(100n + N + W)).settlement!;
    expect(s).toMatchObject({ toProvider: 0n, toLender: 0n, toPayer: 0n, overrun: 0n, lenderShortfall: 0n });
  });

  it("records any owed amount as overrun and pays nothing", () => {
    const ledger = ledgerWith(opened({ lenderPrincipal: 0n, payerDeposit: 0n }), finalized(1n, 5n, 101n));
    expect(ledger.channel(CH)!.overrun).toBe(5n);
    ledger.append(initiated(101n + N));
    const s = ledger.append(reclaimed(101n + N + W)).settlement!;
    expect(sumPayouts(s)).toBe(0n);
    expect(s.overrun).toBe(5n);
  });
});

describe("owed == escrow", () => {
  it("pays the provider everything, recovers nothing, records the lender shortfall", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 1000n, 101n));
    expect(ledger.reclaimable(CH)).toBe(0n);
    expect(ledger.channel(CH)!.overrun).toBe(0n);
    ledger.append(initiated(101n + N));
    const s = ledger.append(reclaimed(101n + N + W)).settlement!;
    expect(s).toMatchObject({ toProvider: 1000n, toLender: 0n, toPayer: 0n, overrun: 0n, lenderShortfall: 700n });
    expect(sumPayouts(s)).toBe(s.escrow);
  });
});

describe("owed > escrow (overrun)", () => {
  it("is accepted, recorded on the channel at finalization, and capped at settlement", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 600n, 101n));
    expect(ledger.channel(CH)!.overrun).toBe(0n);
    ledger.append(finalized(2n, 1600n, 102n));
    expect(ledger.channel(CH)!.overrun).toBe(600n);
    expect(ledger.reclaimable(CH)).toBe(0n);

    ledger.append(initiated(102n + N));
    const s = ledger.append(reclaimed(102n + N + W)).settlement!;
    expect(s).toMatchObject({ owed: 1600n, toProvider: 1000n, overrun: 600n, toLender: 0n, toPayer: 0n });
    expect(sumPayouts(s)).toBe(1000n);
    expect(s.toProvider + s.overrun).toBe(s.owed);
  });

  it("still enforces monotonicity on overrun states", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 5000n, 101n));
    expectRejectedAtomically(ledger, finalized(2n, 4999n, 102n), "OWED_DECREASED");
  });
});

describe("challenge submitted at the last block of the window", () => {
  const start = 100n + N;
  const lastBlock = start + W - 1n;

  it("is accepted at startedAt + W - 1 and counts for settlement", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 100n, 100n), initiated(start));
    expect(ledger.status(CH, lastBlock)).toBe(ChannelStatus.Challenge);
    ledger.append(finalized(2n, 650n, lastBlock));
    expect(ledger.status(CH, lastBlock)).toBe(ChannelStatus.Challenge);
    const s = ledger.append(reclaimed(start + W)).settlement!;
    expect(s).toMatchObject({ nonce: 2n, owed: 650n, toProvider: 650n, toLender: 350n, toPayer: 0n });
  });

  it("is rejected one block later at startedAt + W", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 100n, 100n), initiated(start));
    expectRejectedAtomically(ledger, finalized(2n, 650n, start + W), "CHALLENGE_WINDOW_CLOSED");
    expect(ledger.append(reclaimed(start + W)).settlement!.owed).toBe(100n);
  });

  it("a reclaim in the same block as a last-block challenge is still rejected", () => {
    const ledger = ledgerWith(opened(), initiated(start), finalized(1n, 1n, lastBlock));
    expectRejectedAtomically(ledger, reclaimed(lastBlock), "CHALLENGE_WINDOW_OPEN");
  });
});

describe("stale finalized state replayed", () => {
  it("rejects an exact duplicate of the latest state", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 10n, 101n));
    expectRejectedAtomically(ledger, finalized(1n, 10n, 102n), "STATE_REPLAYED");
  });

  it("rejects an older state replayed after a newer one", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 10n, 101n), finalized(2n, 20n, 102n));
    expectRejectedAtomically(ledger, finalized(1n, 10n, 103n), "STALE_NONCE");
  });

  it("a replay does not count as progress and cannot reset staleness", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 10n, 101n));
    expectCode(() => ledger.append(finalized(1n, 10n, 101n + N)), "STATE_REPLAYED");
    expect(ledger.status(CH, 101n + N)).toBe(ChannelStatus.Stale);
    ledger.append(initiated(101n + N));
  });

  it("a replay during the challenge window is rejected and does not change owed", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 10n, 101n), initiated(101n + N));
    expectRejectedAtomically(ledger, finalized(1n, 10n, 101n + N + 1n), "STATE_REPLAYED");
    expect(ledger.append(reclaimed(101n + N + W)).settlement!.owed).toBe(10n);
  });
});

describe("out-of-order nonces", () => {
  it("rejects a lower nonce arriving after a higher one", () => {
    const ledger = ledgerWith(opened(), finalized(5n, 50n, 101n));
    expectRejectedAtomically(ledger, finalized(3n, 30n, 102n), "STALE_NONCE");
    expectRejectedAtomically(ledger, finalized(4n, 60n, 102n), "STALE_NONCE");
  });

  it("rejects equivocation: same nonce, different content", () => {
    const ledger = ledgerWith(opened(), finalized(5n, 50n, 101n));
    expectRejectedAtomically(ledger, finalized(5n, 50n, 102n, { stateRoot: "other-root" }), "CONFLICTING_STATE");
    expectRejectedAtomically(ledger, finalized(5n, 51n, 102n, { stateRoot: "root-5-50" }), "CONFLICTING_STATE");
  });

  it("accepts the next higher nonce after rejections", () => {
    const ledger = ledgerWith(opened(), finalized(5n, 50n, 101n));
    expectCode(() => ledger.append(finalized(3n, 30n, 102n)), "STALE_NONCE");
    expect(ledger.append(finalized(6n, 60n, 102n)).latest.nonce).toBe(6n);
  });
});

describe("reclaim attempted twice", () => {
  const start = 100n + N;

  it.each([
    ["same block, same caller", start + W, "lender"],
    ["later block, other caller", start + W + 100n, "payer"],
    ["later block, provider", start + W + 1n, "provider"],
  ] as const)("rejects the second reclaim (%s) and keeps the first settlement", (_, height, by) => {
    const ledger = ledgerWith(opened(), finalized(1n, 100n, 100n), initiated(start), reclaimed(start + W));
    const first = ledger.settlement(CH);
    expectRejectedAtomically(ledger, reclaimed(height, by), "ALREADY_SETTLED");
    expect(ledger.settlement(CH)).toBe(first);
    expect(ledger.events.filter((e) => e.type === "Reclaimed")).toHaveLength(1);
  });
});

describe("height going backwards", () => {
  it("rejects events below the ledger head, including on other channels", () => {
    const ledger = ledgerWith(opened(), opened({ channelId: "channel-b", height: 150n }));
    expectRejectedAtomically(ledger, finalized(1n, 1n, 149n), "HEIGHT_REGRESSION");
    expectRejectedAtomically(ledger, opened({ channelId: "channel-c", height: 99n }), "HEIGHT_REGRESSION");
  });

  it("rejects a reclaim whose height is before the challenge start", () => {
    const ledger = ledgerWith(opened(), initiated(100n + N + 20n));
    expectRejectedAtomically(ledger, reclaimed(100n + N + 19n), "HEIGHT_REGRESSION");
  });

  it("allows multiple events at the same height", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 1n, 100n), finalized(2n, 2n, 100n));
    expect(ledger.head).toBe(100n);
  });

  it("rejects status queries below the ledger head", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 1n, 120n));
    expectCode(() => ledger.status(CH, 119n), "HEIGHT_REGRESSION");
    expect(ledger.status(CH, 120n)).toBe(ChannelStatus.Open);
  });
});
