import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ChannelStatus,
  ReclaimError,
  ReclaimLedger,
  computePayouts,
  replay,
  type ChannelView,
  type LedgerEvent,
  type ReclaimParams,
} from "../src/index.js";

const CHANNELS = ["c0", "c1", "c2"] as const;
const ACTORS = ["payer", "provider", "lender", "stranger"] as const;

type Command =
  | { kind: "open"; ch: number; principal: bigint; deposit: bigint; dh: bigint }
  | { kind: "finalize"; ch: number; dNonce: bigint; dOwed: bigint; dh: bigint; altRoot: boolean }
  | { kind: "initiate"; ch: number; by: number; dh: bigint }
  | { kind: "reclaim"; ch: number; by: number; dh: bigint }
  | { kind: "resubmit"; pick: number; dh: bigint };

const heightDelta = fc.oneof(
  { weight: 1, arbitrary: fc.bigInt({ min: -5n, max: -1n }) },
  { weight: 2, arbitrary: fc.constant(0n) },
  { weight: 6, arbitrary: fc.bigInt({ min: 1n, max: 12n }) },
);
const amount = fc.oneof(fc.constant(0n), fc.bigInt({ min: 0n, max: 1_000n }), fc.bigInt({ min: 0n, max: 10n ** 24n }));
const ch = fc.integer({ min: 0, max: CHANNELS.length - 1 });
const actor = fc.integer({ min: 0, max: ACTORS.length - 1 });

const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("open" as const), ch, principal: amount, deposit: amount, dh: heightDelta }) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("finalize" as const),
      ch,
      dNonce: fc.bigInt({ min: -2n, max: 3n }),
      dOwed: fc.oneof(fc.bigInt({ min: -20n, max: 400n }), fc.bigInt({ min: 0n, max: 10n ** 24n })),
      dh: heightDelta,
      altRoot: fc.boolean(),
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("initiate" as const), ch, by: actor, dh: heightDelta }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("reclaim" as const), ch, by: actor, dh: heightDelta }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("resubmit" as const), pick: fc.nat(), dh: heightDelta }) },
);

const paramsArb: fc.Arbitrary<ReclaimParams> = fc.record({
  stalenessBlocks: fc.bigInt({ min: 1n, max: 8n }),
  challengeWindowBlocks: fc.bigInt({ min: 1n, max: 8n }),
  triggerPolicy: fc.constantFrom("channel-parties" as const, "anyone" as const),
});

interface Trace {
  ledger: ReclaimLedger;
  accepted: LedgerEvent[];
  rejected: { event: LedgerEvent; error: ReclaimError }[];
}

function toEvent(cmd: Command, ledger: ReclaimLedger, cursor: bigint, accepted: LedgerEvent[]): LedgerEvent | null {
  const h = cursor + cmd.dh < 0n ? 0n : cursor + cmd.dh;
  switch (cmd.kind) {
    case "open":
      return {
        type: "ChannelOpened",
        channelId: CHANNELS[cmd.ch]!,
        height: h,
        payer: "payer",
        provider: "provider",
        lender: "lender",
        lenderPrincipal: cmd.principal,
        payerDeposit: cmd.deposit,
      };
    case "finalize": {
      const latest = ledger.channel(CHANNELS[cmd.ch]!)?.latest;
      const nonce = (latest?.nonce ?? 0n) + cmd.dNonce;
      const owed = (latest?.cumulativeOwed ?? 0n) + cmd.dOwed;
      return {
        type: "StateFinalized",
        channelId: CHANNELS[cmd.ch]!,
        height: h,
        nonce,
        cumulativeOwed: owed,
        stateRoot: cmd.altRoot && latest?.stateRoot ? latest.stateRoot : `r:${nonce}:${owed}`,
      };
    }
    case "initiate":
      return { type: "ReclaimInitiated", channelId: CHANNELS[cmd.ch]!, height: h, by: ACTORS[cmd.by]! };
    case "reclaim":
      return { type: "Reclaimed", channelId: CHANNELS[cmd.ch]!, height: h, by: ACTORS[cmd.by]! };
    case "resubmit": {
      if (accepted.length === 0) return null;
      const original = accepted[cmd.pick % accepted.length]!;
      return cmd.dh < 0n ? original : { ...original, height: h };
    }
  }
}

function run(params: ReclaimParams, commands: Command[], onStep?: (t: Trace, ev: LedgerEvent, ok: boolean) => void): Trace {
  const ledger = new ReclaimLedger(params);
  const trace: Trace = { ledger, accepted: [], rejected: [] };
  let cursor = 0n;
  for (const cmd of commands) {
    const event = toEvent(cmd, ledger, cursor, trace.accepted);
    if (event === null) continue;
    const stateBefore = ledger.state;
    const lenBefore = ledger.events.length;
    const result = ledger.tryAppend(event);
    if (result.ok) {
      trace.accepted.push(event);
      cursor = event.height;
    } else {
      trace.rejected.push({ event, error: result.error });
      // Atomicity: a rejected event leaves no trace.
      expect(ledger.state).toBe(stateBefore);
      expect(ledger.events.length).toBe(lenBefore);
    }
    onStep?.(trace, event, result.ok);
  }
  return trace;
}

/** Independent model of what the ledger has accepted, derived from the accepted log only. */
function model(accepted: LedgerEvent[]) {
  const perChannel = new Map<
    string,
    { escrow: bigint; principal: bigint; finals: { nonce: bigint; owed: bigint }[]; reclaims: number; eventsAfterClose: number }
  >();
  for (const e of accepted) {
    if (e.type === "ChannelOpened") {
      perChannel.set(e.channelId, {
        escrow: e.lenderPrincipal + e.payerDeposit,
        principal: e.lenderPrincipal,
        finals: [],
        reclaims: 0,
        eventsAfterClose: 0,
      });
      continue;
    }
    const m = perChannel.get(e.channelId)!;
    if (m.reclaims > 0) m.eventsAfterClose++;
    if (e.type === "StateFinalized") m.finals.push({ nonce: e.nonce, owed: e.cumulativeOwed });
    if (e.type === "Reclaimed") m.reclaims++;
  }
  return perChannel;
}

function checkInvariants(trace: Trace, params: ReclaimParams): void {
  const { ledger, accepted } = trace;
  const m = model(accepted);

  // Heights in the accepted log never go backwards.
  for (let i = 1; i < accepted.length; i++) {
    expect(accepted[i]!.height >= accepted[i - 1]!.height).toBe(true);
  }

  let totalEscrowSettled = 0n;
  let totalPaid = 0n;
  for (const [id, mc] of m) {
    const view = ledger.channel(id)!;

    // Monotonicity: nonce strictly increases, cumulative owed never decreases.
    for (let i = 1; i < mc.finals.length; i++) {
      expect(mc.finals[i]!.nonce > mc.finals[i - 1]!.nonce).toBe(true);
      expect(mc.finals[i]!.owed >= mc.finals[i - 1]!.owed).toBe(true);
    }
    const maxOwed = mc.finals.reduce((acc, f) => (f.owed > acc ? f.owed : acc), 0n);
    expect(view.latest.cumulativeOwed).toBe(maxOwed);
    expect(view.overrun).toBe(maxOwed > mc.escrow ? maxOwed - mc.escrow : 0n);

    // No double-claim: at most one settlement and nothing accepted after it.
    expect(mc.reclaims <= 1).toBe(true);
    expect(mc.eventsAfterClose).toBe(0);
    expect(view.settlement !== null).toBe(mc.reclaims === 1);

    const s = view.settlement;
    if (s === null) continue;

    // Conservation: payouts sum to escrow exactly; nothing negative, nothing minted.
    expect(s.escrow).toBe(mc.escrow);
    expect(s.toProvider + s.toLender + s.toPayer).toBe(mc.escrow);
    for (const v of [s.toProvider, s.toLender, s.toPayer, s.overrun, s.lenderShortfall]) expect(v >= 0n).toBe(true);
    totalEscrowSettled += mc.escrow;
    totalPaid += s.toProvider + s.toLender + s.toPayer;

    // Provider safety: paid min(owed, escrow) for the latest finalized state; the rest is recorded overrun.
    expect(s.owed).toBe(maxOwed);
    expect(s.toProvider).toBe(maxOwed < mc.escrow ? maxOwed : mc.escrow);
    expect(s.toProvider + s.overrun).toBe(maxOwed);
    if (maxOwed <= mc.escrow) expect(s.toProvider >= maxOwed).toBe(true);
    for (const f of mc.finals) expect(s.toProvider >= (f.owed < mc.escrow ? f.owed : mc.escrow)).toBe(true);

    // Waterfall ordering.
    expect(s).toMatchObject(computePayouts({ escrow: mc.escrow, lenderPrincipal: mc.principal, owed: maxOwed }));
    if (s.toLender > 0n) expect(s.toProvider).toBe(maxOwed);
    if (s.toPayer > 0n) expect(s.toLender).toBe(mc.principal);
    expect(ledger.status(id, ledger.head!)).toBe(ChannelStatus.Closed);
  }
  expect(totalPaid).toBe(totalEscrowSettled);

  // Determinism: the log alone reproduces the projection.
  expect(replay(ledger.events, params)).toEqual(ledger.state);
}

const RUNS = Number(process.env.PROPERTY_RUNS ?? 300);
// fast-check's default "small" size caps arrays near 10 elements, too short to
// drive a channel through stale -> challenge -> reclaim.
const sequences = fc.array(command, { minLength: 1, maxLength: 80, size: "max" });

describe("invariants over random event sequences", () => {
  it("conservation, provider-safety, no double-claim, monotonicity, height order, atomicity, determinism", () => {
    fc.assert(
      fc.property(paramsArb, sequences, (params, cmds) => {
        const trace = run(params, cmds);
        checkInvariants(trace, params);
      }),
      { numRuns: RUNS },
    );
  });

  it("invariants hold after every single step, not just at the end", () => {
    fc.assert(
      fc.property(paramsArb, fc.array(command, { minLength: 1, maxLength: 40, size: "max" }), (params, cmds) => {
        run(params, cmds, (trace) => checkInvariants(trace, params));
      }),
      { numRuns: Math.max(50, Math.floor(RUNS / 3)) },
    );
  });

  it("re-submitting any previously accepted event is always rejected", () => {
    fc.assert(
      fc.property(paramsArb, sequences, fc.nat(), fc.bigInt({ min: 0n, max: 20n }), (params, cmds, pick, bump) => {
        const { ledger, accepted } = run(params, cmds);
        if (accepted.length === 0) return;
        const original = accepted[pick % accepted.length]!;
        const head = ledger.head!;
        for (const height of [original.height, head, head + bump]) {
          const r = ledger.tryAppend({ ...original, height });
          if (r.ok) throw new Error(`re-submitted ${original.type} was accepted at height ${height}`);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("the reached status is always consistent with the accepted log", () => {
    fc.assert(
      fc.property(paramsArb, sequences, fc.bigInt({ min: 0n, max: 40n }), (params, cmds, ahead) => {
        const { ledger } = run(params, cmds);
        if (ledger.head === null) return;
        const h = ledger.head + ahead;
        for (const view of ledger.channels()) {
          const status = ledger.status(view.channelId, h);
          if (view.settlement) expect(status).toBe(ChannelStatus.Closed);
          else if (view.challenge)
            expect(status).toBe(h >= view.challenge.reclaimableAt ? ChannelStatus.Reclaimable : ChannelStatus.Challenge);
          else expect(status).toBe(h - view.latest.height >= params.stalenessBlocks ? ChannelStatus.Stale : ChannelStatus.Open);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe("liveness", () => {
  /**
   * From any reachable ledger, every unsettled channel can be driven to Closed
   * by a lender acting alone, no later than max(head, progress + N) + W, even
   * if the provider keeps submitting newer finalized states during the window.
   */
  it("every stale channel becomes reclaimable after staleness + challenge window, despite an adversarial provider", () => {
    fc.assert(
      fc.property(
        paramsArb,
        sequences,
        fc.array(fc.tuple(fc.bigInt({ min: 0n, max: 10n }), fc.bigInt({ min: 0n, max: 500n })), { maxLength: 6 }),
        fc.bigInt({ min: 0n, max: 30n }),
        (params, cmds, providerSpam, lenderDelay) => {
          const base = run(params, cmds).ledger;
          for (const view of base.channels()) {
            if (view.settlement !== null) continue;
            const ledger = ReclaimLedger.fromEvents(params, base.events);
            const head = ledger.head!;
            let deadline: bigint;
            if (view.challenge === null) {
              const staleAt = view.latest.height + params.stalenessBlocks;
              const initAt = (head > staleAt ? head : staleAt) + lenderDelay;
              expect(ledger.status(view.channelId, initAt)).toBe(ChannelStatus.Stale);
              ledger.append({ type: "ReclaimInitiated", channelId: view.channelId, height: initAt, by: "lender" });
              deadline = initAt + params.challengeWindowBlocks;
              expect(ledger.earliestReclaimHeight(view.channelId)).toBe(deadline);
            } else {
              deadline = view.challenge.reclaimableAt;
            }

            // Adversarial provider: valid newer states inside the window must not delay reclaim.
            let cur: ChannelView = ledger.channel(view.channelId)!;
            for (const [dh, dOwed] of providerSpam) {
              const h = ledger.head! + dh;
              if (h >= deadline) break;
              cur = ledger.append({
                type: "StateFinalized",
                channelId: view.channelId,
                height: h,
                nonce: cur.latest.nonce + 1n,
                cumulativeOwed: cur.latest.cumulativeOwed + dOwed,
                stateRoot: `spam:${cur.latest.nonce + 1n}`,
              });
              expect(cur.challenge!.reclaimableAt).toBe(deadline);
            }

            const at = ledger.head! > deadline ? ledger.head! : deadline;
            expect(ledger.status(view.channelId, at)).toBe(ChannelStatus.Reclaimable);
            const closed = ledger.append({ type: "Reclaimed", channelId: view.channelId, height: at, by: "lender" });
            expect(closed.settlement).not.toBeNull();
            expect(ledger.status(view.channelId, at)).toBe(ChannelStatus.Closed);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("generator coverage", () => {
  it("random sequences actually reach every status, settlements, overruns and every rejection class", () => {
    const codes = new Set<string>();
    const statuses = new Set<string>();
    let settled = 0;
    let overrunSettled = 0;
    for (const [params, cmds] of fc.sample(fc.tuple(paramsArb, sequences), { numRuns: 400, seed: 42 })) {
      const t = run(params, cmds, (trace) => {
        const h = trace.ledger.head;
        if (h === null) return;
        for (const v of trace.ledger.channels()) statuses.add(trace.ledger.status(v.channelId, h));
      });
      for (const r of t.rejected) codes.add(r.error.code);
      for (const v of t.ledger.channels()) {
        if (v.settlement) settled++;
        if (v.settlement && v.settlement.overrun > 0n) overrunSettled++;
      }
    }
    expect(settled).toBeGreaterThan(50);
    expect(overrunSettled).toBeGreaterThan(0);
    expect([...statuses].sort()).toEqual(Object.values(ChannelStatus).sort());
    for (const code of [
      "HEIGHT_REGRESSION",
      "UNKNOWN_CHANNEL",
      "DUPLICATE_CHANNEL",
      "CHANNEL_CLOSED",
      "ALREADY_SETTLED",
      "STALE_NONCE",
      "STATE_REPLAYED",
      "CONFLICTING_STATE",
      "OWED_DECREASED",
      "NOT_STALE",
      "CHALLENGE_ALREADY_STARTED",
      "NO_CHALLENGE",
      "CHALLENGE_WINDOW_OPEN",
      "CHALLENGE_WINDOW_CLOSED",
      "UNAUTHORIZED",
      "INVALID_EVENT",
    ]) {
      expect(codes, code).toContain(code);
    }
  });
});

describe("payout formula over arbitrary amounts", () => {
  it("conserves escrow, never goes negative, pays provider min(owed, escrow), respects seniority", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.bigInt({ min: 0n, max: 10n ** 31n }),
        (principal, deposit, owed) => {
          const escrow = principal + deposit;
          const p = computePayouts({ escrow, lenderPrincipal: principal, owed });
          expect(p.toProvider + p.toLender + p.toPayer).toBe(escrow);
          expect(p.toProvider + p.overrun).toBe(owed);
          expect(p.toLender + p.lenderShortfall).toBe(principal);
          for (const v of Object.values(p)) expect(v >= 0n).toBe(true);
          expect(p.toProvider).toBe(owed < escrow ? owed : escrow);
          if (p.toLender > 0n) expect(p.overrun).toBe(0n);
          if (p.toPayer > 0n) expect(p.lenderShortfall).toBe(0n);
        },
      ),
      { numRuns: RUNS * 3 },
    );
  });
});
