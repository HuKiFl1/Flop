import { describe, expect, it } from "vitest";
import {
  ChannelStatus,
  ReclaimLedger,
  replay,
  type LedgerEvent,
  type ReclaimParams,
} from "../src/index.js";
import {
  CH,
  N,
  PARAMS,
  W,
  expectCode,
  expectRejectedAtomically,
  finalized,
  initiated,
  ledgerWith,
  opened,
  reclaimed,
} from "./helpers.js";

describe("params", () => {
  it.each<[string, Partial<ReclaimParams>]>([
    ["zero staleness", { stalenessBlocks: 0n }],
    ["zero window", { challengeWindowBlocks: 0n }],
    ["number staleness", { stalenessBlocks: 10 as unknown as bigint }],
    ["unknown policy", { triggerPolicy: "owner" as unknown as "anyone" }],
    ["non-function verifier", { verifyState: 1 as unknown as () => boolean }],
  ])("rejects %s", (_, overrides) => {
    expectCode(() => new ReclaimLedger({ ...PARAMS, ...overrides }), "INVALID_PARAMS");
  });
});

describe("ChannelOpened (-> Open)", () => {
  it("creates an Open channel with escrow = lenderPrincipal + payerDeposit and an implicit nonce-0 state", () => {
    const ledger = ledgerWith(opened());
    const ch = ledger.channel(CH)!;
    expect(ch.escrow).toBe(1000n);
    expect(ch.latest).toEqual({ nonce: 0n, cumulativeOwed: 0n, stateRoot: null, height: 100n });
    expect(ch.challenge).toBeNull();
    expect(ch.settlement).toBeNull();
    expect(ledger.status(CH, 100n)).toBe(ChannelStatus.Open);
    expect(ledger.head).toBe(100n);
  });

  it("rejects a reused channel id", () => {
    const ledger = ledgerWith(opened());
    expectRejectedAtomically(ledger, opened({ height: 200n }), "DUPLICATE_CHANNEL");
  });

  it.each<[string, Parameters<typeof opened>[0]]>([
    ["negative principal", { lenderPrincipal: -1n }],
    ["negative deposit", { payerDeposit: -1n }],
    ["float principal", { lenderPrincipal: 1.5 as unknown as bigint }],
    ["number deposit", { payerDeposit: 1 as unknown as bigint }],
    ["empty payer", { payer: "" }],
    ["empty lender", { lender: "" }],
    ["payer == provider", { provider: "payer" }],
    ["empty channel id", { channelId: "" }],
    ["negative height", { height: -1n }],
    ["number height", { height: 5 as unknown as bigint }],
  ])("rejects %s", (_, overrides) => {
    expectRejectedAtomically(new ReclaimLedger(PARAMS), opened(overrides), "INVALID_EVENT");
  });

  it("rejects unknown event types", () => {
    const ledger = new ReclaimLedger(PARAMS);
    expectCode(
      () => ledger.append({ type: "Mint", channelId: CH, height: 1n } as unknown as LedgerEvent),
      "INVALID_EVENT",
    );
  });
});

describe("events for unknown channels", () => {
  it.each<[string, LedgerEvent]>([
    ["StateFinalized", finalized(1n, 1n, 101n)],
    ["ReclaimInitiated", initiated(101n)],
    ["Reclaimed", reclaimed(101n)],
  ])("rejects %s", (_, event) => {
    expectRejectedAtomically(new ReclaimLedger(PARAMS), event, "UNKNOWN_CHANNEL");
  });

  it("status query on an unknown channel throws", () => {
    expectCode(() => new ReclaimLedger(PARAMS).status("nope", 0n), "UNKNOWN_CHANNEL");
  });
});

describe("StateFinalized (Open -> Open)", () => {
  it("records the newer state and resets the staleness clock", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 50n, 105n));
    const ch = ledger.channel(CH)!;
    expect(ch.latest).toEqual({ nonce: 1n, cumulativeOwed: 50n, stateRoot: "root-1-50", height: 105n });
    expect(ledger.status(CH, 105n + N - 1n)).toBe(ChannelStatus.Open);
    expect(ledger.status(CH, 105n + N)).toBe(ChannelStatus.Stale);
  });

  it("allows nonce gaps and equal cumulative owed", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 50n, 101n), finalized(7n, 50n, 102n));
    expect(ledger.channel(CH)!.latest.nonce).toBe(7n);
  });

  it.each<[string, ReturnType<typeof finalized>]>([
    ["nonce 0", finalized(0n, 1n, 101n)],
    ["negative owed", finalized(1n, -1n, 101n)],
    ["number nonce", finalized(1 as unknown as bigint, 1n, 101n)],
    ["empty state root", finalized(1n, 1n, 101n, { stateRoot: "" })],
  ])("rejects %s", (_, event) => {
    expectRejectedAtomically(ledgerWith(opened()), event, "INVALID_EVENT");
  });

  it("rejects a higher nonce with a lower cumulative owed amount", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 50n, 101n));
    expectRejectedAtomically(ledger, finalized(2n, 49n, 102n), "OWED_DECREASED");
  });

  it("consults verifyState and rejects states it does not accept", () => {
    const seen: string[] = [];
    const ledger = new ReclaimLedger({
      ...PARAMS,
      verifyState: (channel, state) => {
        seen.push(`${channel.channelId}:${state.nonce}`);
        return state.stateRoot.startsWith("signed:");
      },
    });
    ledger.append(opened());
    ledger.append(finalized(1n, 10n, 101n, { stateRoot: "signed:abc" }));
    expectRejectedAtomically(ledger, finalized(2n, 20n, 102n, { stateRoot: "forged" }), "STATE_REJECTED");
    expect(seen).toEqual([`${CH}:1`, `${CH}:2`]);
  });
});

describe("Open -> Stale (passage of blocks only)", () => {
  it("becomes Stale exactly N blocks after the last finalized state", () => {
    const ledger = ledgerWith(opened());
    expect(ledger.status(CH, 100n + N - 1n)).toBe(ChannelStatus.Open);
    expect(ledger.status(CH, 100n + N)).toBe(ChannelStatus.Stale);
    expect(ledger.status(CH, 100n + 1000n * N)).toBe(ChannelStatus.Stale);
  });

  it("Stale -> Open when a newer finalized state arrives before anyone initiates reclaim", () => {
    const ledger = ledgerWith(opened());
    ledger.append(finalized(1n, 10n, 100n + N + 3n));
    expect(ledger.status(CH, 100n + N + 3n)).toBe(ChannelStatus.Open);
  });
});

describe("ReclaimInitiated (Stale -> Challenge)", () => {
  it.each(["lender", "payer", "provider"])("is accepted from channel party %s once Stale", (by) => {
    const ledger = ledgerWith(opened());
    const ch = ledger.append(initiated(100n + N, by));
    expect(ch.challenge).toEqual({ startedAt: 100n + N, by, reclaimableAt: 100n + N + W });
    expect(ledger.status(CH, 100n + N)).toBe(ChannelStatus.Challenge);
  });

  it("is rejected while the channel is Open", () => {
    expectRejectedAtomically(ledgerWith(opened()), initiated(100n + N - 1n), "NOT_STALE");
  });

  it("is rejected from a non-party under channel-parties policy", () => {
    expectRejectedAtomically(ledgerWith(opened()), initiated(100n + N, "stranger"), "UNAUTHORIZED");
  });

  it("is accepted from anyone under the anyone policy", () => {
    const ledger = ReclaimLedger.fromEvents({ ...PARAMS, triggerPolicy: "anyone" }, [opened()]);
    expect(ledger.append(initiated(100n + N, "keeper-bot")).challenge?.by).toBe("keeper-bot");
  });

  it("rejects an empty caller", () => {
    expectRejectedAtomically(ledgerWith(opened()), initiated(100n + N, ""), "INVALID_EVENT");
  });

  it("cannot be initiated twice", () => {
    const ledger = ledgerWith(opened(), initiated(100n + N));
    expectRejectedAtomically(ledger, initiated(100n + N + 1n, "payer"), "CHALLENGE_ALREADY_STARTED");
    ledger.append(reclaimed(100n + N + W)); // still Closed-able afterwards
  });
});

describe("Challenge", () => {
  const start = 100n + N;

  it("accepts a newer finalized state, updates owed, keeps the window fixed", () => {
    const ledger = ledgerWith(opened(), initiated(start));
    const ch = ledger.append(finalized(3n, 400n, start + 2n));
    expect(ch.latest.cumulativeOwed).toBe(400n);
    expect(ch.challenge?.reclaimableAt).toBe(start + W);
    expect(ledger.status(CH, start + 2n)).toBe(ChannelStatus.Challenge);
    expect(ledger.status(CH, start + W)).toBe(ChannelStatus.Reclaimable);
  });

  it("rejects Reclaimed before the window elapses", () => {
    const ledger = ledgerWith(opened(), initiated(start));
    expectRejectedAtomically(ledger, reclaimed(start + W - 1n), "CHALLENGE_WINDOW_OPEN");
  });
});

describe("Reclaimable", () => {
  const start = 100n + N;

  it("is reached exactly W blocks after initiation", () => {
    const ledger = ledgerWith(opened(), initiated(start));
    expect(ledger.status(CH, start + W - 1n)).toBe(ChannelStatus.Challenge);
    expect(ledger.status(CH, start + W)).toBe(ChannelStatus.Reclaimable);
  });

  it("no longer accepts finalized states", () => {
    const ledger = ledgerWith(opened(), initiated(start));
    expectRejectedAtomically(ledger, finalized(1n, 10n, start + W), "CHALLENGE_WINDOW_CLOSED");
  });
});

describe("Reclaimed (Reclaimable -> Closed)", () => {
  const start = 100n + N;

  it("settles with the waterfall and closes the channel", () => {
    const ledger = ledgerWith(opened(), finalized(1n, 120n, 101n), initiated(101n + N, "payer"));
    expect(ledger.reclaimable(CH)).toBe(880n);
    const ch = ledger.append(reclaimed(101n + N + W, "provider"));
    expect(ch.settlement).toEqual({
      channelId: CH,
      height: 101n + N + W,
      by: "provider",
      nonce: 1n,
      owed: 120n,
      escrow: 1000n,
      toProvider: 120n,
      toLender: 700n,
      toPayer: 180n,
      overrun: 0n,
      lenderShortfall: 0n,
    });
    expect(ledger.status(CH, 101n + N + W)).toBe(ChannelStatus.Closed);
    expect(ledger.earliestReclaimHeight(CH)).toBeNull();
  });

  it("requires a prior ReclaimInitiated even when Stale", () => {
    expectRejectedAtomically(ledgerWith(opened()), reclaimed(100n + N + W), "NO_CHALLENGE");
  });

  it("rejects a non-party caller under channel-parties policy", () => {
    const ledger = ledgerWith(opened(), initiated(start));
    expectRejectedAtomically(ledger, reclaimed(start + W, "stranger"), "UNAUTHORIZED");
  });

  it("can execute late; payouts do not depend on when or by whom", () => {
    const a = ledgerWith(opened(), initiated(start), reclaimed(start + W, "lender"));
    const b = ledgerWith(opened(), initiated(start), reclaimed(start + 10_000n, "payer"));
    const strip = (s: NonNullable<ReturnType<typeof a.settlement>>) => ({ ...s, height: 0n, by: "" });
    expect(strip(a.settlement(CH)!)).toEqual(strip(b.settlement(CH)!));
  });
});

describe("Closed", () => {
  const start = 100n + N;
  const closedLedger = () => ledgerWith(opened(), initiated(start), reclaimed(start + W));

  it("rejects further finalized states", () => {
    expectRejectedAtomically(closedLedger(), finalized(1n, 1n, start + W), "CHANNEL_CLOSED");
  });

  it("rejects re-initiation", () => {
    expectRejectedAtomically(closedLedger(), initiated(start + W + N), "CHANNEL_CLOSED");
  });

  it("rejects re-opening the same id", () => {
    expectRejectedAtomically(closedLedger(), opened({ height: start + W }), "DUPLICATE_CHANNEL");
  });
});

describe("ledger mechanics", () => {
  it("is deterministic: replaying the log reproduces identical projections", () => {
    const ledger = ledgerWith(
      opened(),
      opened({ channelId: "channel-b", height: 101n }),
      finalized(1n, 30n, 102n),
      initiated(102n + N),
      reclaimed(102n + N + W),
    );
    const rebuilt = replay(ledger.events, PARAMS);
    expect(rebuilt).toEqual(ledger.state);
    expect(ReclaimLedger.fromEvents(PARAMS, ledger.events).state).toEqual(ledger.state);
  });

  it("stores frozen copies, so callers cannot rewrite history", () => {
    const ledger = new ReclaimLedger(PARAMS);
    const ev = { ...opened() };
    ledger.append(ev);
    ev.lenderPrincipal = 1n;
    expect(ledger.channel(CH)!.lenderPrincipal).toBe(700n);
    expect(Object.isFrozen(ledger.events[0])).toBe(true);
    (ledger.events as LedgerEvent[]).pop();
    expect(ledger.events.length).toBe(1);
  });

  it("tryAppend returns typed results instead of throwing", () => {
    const ledger = ledgerWith(opened());
    const bad = ledger.tryAppend(initiated(101n));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("NOT_STALE");
    const good = ledger.tryAppend(finalized(1n, 1n, 101n));
    expect(good.ok).toBe(true);
  });

  it("reports earliest reclaim height before and during a challenge", () => {
    const ledger = ledgerWith(opened());
    expect(ledger.earliestReclaimHeight(CH)).toBe(100n + N + W);
    ledger.append(initiated(100n + N + 4n));
    expect(ledger.earliestReclaimHeight(CH)).toBe(100n + N + 4n + W);
  });
});
