import { describe, expect, it } from 'vitest';

import {
  createWatchdog,
  DEFAULT_WATCHDOG_CONFIG,
  FINAL_REVIEW_MISSING,
  progressMarker,
  type WatchdogObservation,
} from '../src/watchdog.ts';

const MIN = 60_000;
const T0 = 1_000_000_000;

function obs(over: Partial<WatchdogObservation> = {}): WatchdogObservation {
  return {
    rootId: 'root',
    sessions: [{ id: 'root', busy: false, lastEventTs: T0 }],
    progressMarker: 'm0',
    runCompleteSeen: false,
    finalReviewExists: false,
    errors: [],
    ...over,
  };
}

function make(config = {}) {
  return createWatchdog(config, () => T0);
}

describe('defaults', () => {
  it('match AD7', () => {
    expect(DEFAULT_WATCHDOG_CONFIG).toEqual({
      idleMs: 3 * MIN,
      hungMs: 40 * MIN,
      toolMaxMs: 60 * MIN,
      maxNudges: 10,
      stallNudges: 3,
      backoffBaseMs: MIN,
      backoffCapMs: 45 * MIN,
      wallclockMs: 10 * 60 * MIN,
      wallclockSoftLeadMs: 30 * MIN,
    });
  });
});

describe('nudge', () => {
  it('does nothing before the tick has an observation', () => {
    expect(make().tick(T0 + 60 * MIN)).toEqual([]);
  });

  it('nudges only after 3 min idle', () => {
    const w = make();
    w.observe(obs());
    expect(w.tick(T0 + 3 * MIN - 1)).toEqual([]);
    expect(w.tick(T0 + 3 * MIN)).toEqual([{ type: 'nudge' }]);
  });

  it('waits another idle period after a nudge', () => {
    const w = make();
    w.observe(obs());
    w.tick(T0 + 3 * MIN);
    expect(w.tick(T0 + 4 * MIN)).toEqual([]);
    expect(w.tick(T0 + 6 * MIN)).toEqual([{ type: 'nudge' }]);
  });

  it('does not nudge while a child is busy', () => {
    const w = make();
    w.observe(obs({ sessions: [{ id: 'root', busy: false, lastEventTs: T0 }, { id: 'c1', busy: true, lastEventTs: T0 + 9 * MIN }] }));
    expect(w.tick(T0 + 10 * MIN)).toEqual([]);
  });

  it('does not nudge while the root itself is busy', () => {
    const w = make();
    w.observe(obs({ sessions: [{ id: 'root', busy: true, lastEventTs: T0 + 9 * MIN }] }));
    expect(w.tick(T0 + 10 * MIN)).toEqual([]);
  });

  it('measures idleness from the root last event', () => {
    const w = make();
    w.observe(obs({ sessions: [{ id: 'root', busy: false, lastEventTs: T0 + 10 * MIN }] }));
    expect(w.tick(T0 + 12 * MIN)).toEqual([]);
    expect(w.tick(T0 + 13 * MIN)).toEqual([{ type: 'nudge' }]);
  });

  it('is configurable', () => {
    const w = make({ idleMs: 1000 });
    w.observe(obs());
    expect(w.tick(T0 + 1000)).toEqual([{ type: 'nudge' }]);
  });

  it('stops at the max and reports stalled', () => {
    const w = make({ maxNudges: 2, stallNudges: 99 });
    w.observe(obs());
    let now = T0;
    for (let i = 0; i < 2; i++) {
      now += 3 * MIN;
      expect(w.tick(now)).toEqual([{ type: 'nudge' }]);
    }
    now += 3 * MIN;
    expect(w.tick(now)).toEqual([{ type: 'stalled', reason: 'max nudges (2) reached' }]);
    expect(w.snapshot().nudges).toBe(2);
  });
});

describe('stalled', () => {
  it('fires after 3 nudges without a progress change', () => {
    const w = make();
    w.observe(obs());
    let now = T0;
    for (let i = 0; i < 3; i++) {
      now += 3 * MIN;
      expect(w.tick(now)).toEqual([{ type: 'nudge' }]);
      w.observe(obs());
    }
    now += 3 * MIN;
    expect(w.tick(now)).toEqual([{ type: 'stalled', reason: '3 nudges without progress' }]);
  });

  it('a marker change resets the stall counter', () => {
    const w = make();
    w.observe(obs());
    let now = T0;
    for (let i = 0; i < 2; i++) {
      now += 3 * MIN;
      w.tick(now);
    }
    w.observe(obs({ progressMarker: 'm1' }));
    expect(w.snapshot().nudgesSinceProgress).toBe(0);
    for (let i = 0; i < 3; i++) {
      now += 3 * MIN;
      expect(w.tick(now)).toEqual([{ type: 'nudge' }]);
    }
    expect(w.snapshot().nudges).toBe(5);
  });

  it('latches: terminal actions are emitted once', () => {
    const w = make({ stallNudges: 0 });
    w.observe(obs());
    expect(w.tick(T0 + 3 * MIN)[0]?.type).toBe('stalled');
    expect(w.tick(T0 + 30 * MIN)).toEqual([]);
  });
});

describe('hung sessions', () => {
  const sessions = (childLast: number) => [
    { id: 'root', busy: false, lastEventTs: T0 },
    { id: 'c1', busy: true, lastEventTs: childLast },
  ];

  it('aborts a busy session silent for the hung period (20 min configured)', () => {
    const w = make({ hungMs: 20 * MIN });
    w.observe(obs({ sessions: sessions(T0) }));
    expect(w.tick(T0 + 20 * MIN - 1)).toEqual([]);
    expect(w.tick(T0 + 20 * MIN)).toEqual([{ type: 'abort-session', id: 'c1' }]);
  });

  it('does not repeat the abort immediately, but retries after another hung period', () => {
    const w = make({ hungMs: 20 * MIN });
    w.observe(obs({ sessions: sessions(T0) }));
    expect(w.tick(T0 + 20 * MIN)).toHaveLength(1);
    expect(w.tick(T0 + 25 * MIN)).toEqual([]);
    expect(w.tick(T0 + 40 * MIN)).toEqual([{ type: 'abort-session', id: 'c1' }]);
  });

  it('ignores idle sessions however old', () => {
    const w = make();
    w.observe(obs({ sessions: [{ id: 'root', busy: false, lastEventTs: T0 }, { id: 'c1', busy: false, lastEventTs: T0 }] }));
    expect(w.tick(T0 + 19 * MIN).some((a) => a.type === 'abort-session')).toBe(false);
  });

  it('aborts a hung root as well', () => {
    const w = make({ hungMs: 20 * MIN });
    w.observe(obs({ sessions: [{ id: 'root', busy: true, lastEventTs: T0 }] }));
    expect(w.tick(T0 + 21 * MIN)).toEqual([{ type: 'abort-session', id: 'root' }]);
  });
});

describe('hung sessions with a running tool', () => {
  const busy = (toolSince?: number) => [
    { id: 'root', busy: false, lastEventTs: T0 },
    { id: 'c1', busy: true, lastEventTs: T0, ...(toolSince === undefined ? {} : { runningToolSinceTs: toolSince }) },
  ];

  it('defaults to 40 min of silence', () => {
    const w = make();
    w.observe(obs({ sessions: busy() }));
    expect(w.tick(T0 + 40 * MIN - 1)).toEqual([]);
    expect(w.tick(T0 + 40 * MIN)).toEqual([{ type: 'abort-session', id: 'c1' }]);
  });

  it('a session with a tool call in flight is not hung, however silent', () => {
    const w = make();
    w.observe(obs({ sessions: busy(T0) }));
    expect(w.tick(T0 + 41 * MIN)).toEqual([]);
    expect(w.tick(T0 + 60 * MIN)).toEqual([]);
  });

  it('is hung once the tool has run for more than 60 min', () => {
    const w = make();
    w.observe(obs({ sessions: busy(T0) }));
    expect(w.tick(T0 + 60 * MIN)).toEqual([]);
    expect(w.tick(T0 + 60 * MIN + 1)).toEqual([{ type: 'abort-session', id: 'c1' }]);
  });

  it('a fresh tool call resets the exemption window (judged by the oldest in-flight call)', () => {
    const w = make();
    w.observe(obs({ sessions: busy(T0 + 50 * MIN) }));
    expect(w.tick(T0 + 100 * MIN)).toEqual([]);
  });
});

describe('backoff', () => {
  it('announces a backoff of 1 min on the first error and suppresses nudges meanwhile', () => {
    const w = make({ idleMs: 10 });
    const errTs = T0 + 100;
    w.observe(obs({ errors: [{ kind: '429', ts: errTs }] }));
    expect(w.tick(errTs + 1)).toEqual([{ type: 'backoff', untilTs: errTs + MIN }]);
    // announced once only; nudges still suppressed
    expect(w.tick(errTs + MIN - 1)).toEqual([]);
    expect(w.snapshot().nudges).toBe(0);
    expect(w.tick(errTs + MIN)).toEqual([{ type: 'nudge' }]);
  });

  it('doubles per escalation and caps at 45 min', () => {
    const w = make({ idleMs: 10 });
    let ts = T0;
    const untils: number[] = [];
    const errors: { kind: '5xx'; ts: number }[] = [];
    for (let i = 0; i < 9; i++) {
      ts += 1;
      errors.push({ kind: '5xx', ts });
      w.observe(obs({ errors: [...errors] }));
      const a = w.tick(ts);
      const b = a.find((x) => x.type === 'backoff');
      expect(b).toBeDefined();
      if (b?.type === 'backoff') {
        untils.push(b.untilTs - ts);
        ts = b.untilTs; // next error lands right after the window
      }
    }
    expect(untils).toEqual([1, 2, 4, 8, 16, 32, 45, 45, 45].map((m) => m * MIN));
  });

  it('errors inside an active backoff do not escalate', () => {
    const w = make();
    w.observe(obs({ errors: [{ kind: '429', ts: T0 + 1 }] }));
    w.tick(T0 + 2);
    w.observe(obs({ errors: [{ kind: '429', ts: T0 + 1 }, { kind: 'session-error', ts: T0 + 500 }] }));
    expect(w.tick(T0 + 501)).toEqual([]);
    expect(w.snapshot().backoffStreak).toBe(1);
  });

  it('re-observing the same errors does not re-trigger', () => {
    const w = make();
    const e = [{ kind: '429' as const, ts: T0 + 1 }];
    w.observe(obs({ errors: e }));
    w.tick(T0 + 2);
    w.observe(obs({ errors: e }));
    expect(w.tick(T0 + 3)).toEqual([]);
    expect(w.snapshot().backoffStreak).toBe(1);
  });

  it('progress resets the streak', () => {
    const w = make();
    w.observe(obs({ errors: [{ kind: '429', ts: T0 + 1 }] }));
    w.observe(obs({ progressMarker: 'm1', errors: [{ kind: '429', ts: T0 + 1 }] }));
    expect(w.snapshot().backoffStreak).toBe(0);
  });

  it('does not count toward nudges or stalls', () => {
    const w = make();
    w.observe(obs({ errors: [{ kind: '429', ts: T0 + 1 }] }));
    w.tick(T0 + 2);
    const s = w.snapshot();
    expect(s.nudges).toBe(0);
    expect(s.nudgesSinceProgress).toBe(0);
  });

  it('still aborts hung sessions during a backoff', () => {
    const w = make({ hungMs: 20 * MIN });
    w.observe(
      obs({
        sessions: [{ id: 'root', busy: true, lastEventTs: T0 }],
        errors: [{ kind: '429', ts: T0 + 25 * MIN }],
      }),
    );
    const a = w.tick(T0 + 26 * MIN);
    expect(a.map((x) => x.type)).toEqual(['abort-session', 'backoff']);
  });
});

describe('wallclock-soft', () => {
  it('fires once, 30 min before the wall clock, and does not end the watchdog', () => {
    const w = make();
    w.observe(obs());
    const at = T0 + 10 * 60 * MIN - 30 * MIN;
    expect(w.tick(at).map((a) => a.type)).not.toContain('wallclock-soft');
    expect(w.tick(at + 1).map((a) => a.type)).toContain('wallclock-soft');
    expect(w.tick(at + 2).map((a) => a.type)).not.toContain('wallclock-soft');
    expect(w.snapshot().done).toBe(false);
    expect(w.tick(T0 + 10 * 60 * MIN + 1)).toEqual([{ type: 'wallclock' }]);
  });

  it('is off when the wall clock is not longer than the lead', () => {
    const w = make({ wallclockMs: 30 * MIN });
    w.observe(obs());
    expect(w.tick(T0 + 5 * MIN).map((a) => a.type)).not.toContain('wallclock-soft');
  });

  it('survives a snapshot round trip (not repeated after a restore)', () => {
    const w = make();
    w.observe(obs());
    w.tick(T0 + 9.5 * 60 * MIN + 1);
    const w2 = createWatchdog({}, () => T0, w.snapshot());
    w2.observe(obs());
    expect(w2.tick(T0 + 9.6 * 60 * MIN).map((a) => a.type)).not.toContain('wallclock-soft');
  });
});

describe('wallclock', () => {
  it('fires when elapsed exceeds 10 h, even with an observation of nothing', () => {
    const w = make();
    expect(w.tick(T0 + 10 * 60 * MIN)).toEqual([]);
    expect(w.tick(T0 + 10 * 60 * MIN + 1)).toEqual([{ type: 'wallclock' }]);
    expect(w.tick(T0 + 11 * 60 * MIN)).toEqual([]);
  });

  it('is configurable', () => {
    const w = make({ wallclockMs: 5 * MIN });
    w.observe(obs());
    expect(w.tick(T0 + 5 * MIN + 1)).toEqual([{ type: 'wallclock' }]);
  });
});

describe('completion', () => {
  it('completes when run.complete was seen and the final review exists', () => {
    const w = make();
    w.observe(obs({ runCompleteSeen: true, finalReviewExists: true }));
    expect(w.tick(T0 + 1)).toEqual([{ type: 'complete' }]);
    expect(w.tick(T0 + 2)).toEqual([]);
  });

  it('nudges once, immediately, with a reason when the final review is missing', () => {
    const w = make();
    w.observe(obs({ runCompleteSeen: true, finalReviewExists: false }));
    expect(w.tick(T0 + 1)).toEqual([{ type: 'nudge', reason: FINAL_REVIEW_MISSING }]);
    expect(w.tick(T0 + 2)).toEqual([]);
    expect(w.snapshot().nudges).toBe(1);
  });

  it('keeps nudging on the idle cadence while the review stays missing, and completes once it appears', () => {
    const w = make();
    w.observe(obs({ runCompleteSeen: true }));
    w.tick(T0 + 1);
    expect(w.tick(T0 + 3 * MIN + 1)).toEqual([{ type: 'nudge', reason: FINAL_REVIEW_MISSING }]);
    w.observe(obs({ runCompleteSeen: true, finalReviewExists: true }));
    expect(w.tick(T0 + 4 * MIN)).toEqual([{ type: 'complete' }]);
  });

  it('a final review without run.complete is not completion', () => {
    const w = make();
    w.observe(obs({ finalReviewExists: true }));
    expect(w.tick(T0 + 1)).toEqual([]);
  });

  it('wallclock beats complete only if exceeded first', () => {
    const w = make({ wallclockMs: 10 });
    w.observe(obs({ runCompleteSeen: true, finalReviewExists: true }));
    expect(w.tick(T0 + 11)).toEqual([{ type: 'wallclock' }]);
  });
});

describe('snapshot / restore', () => {
  it('round-trips through JSON and continues where it left off', () => {
    const w = make();
    w.observe(obs());
    w.tick(T0 + 3 * MIN);
    w.tick(T0 + 6 * MIN);
    const snap = JSON.parse(JSON.stringify(w.snapshot()));
    expect(snap.nudges).toBe(2);

    const w2 = createWatchdog({}, () => T0 + 999 * MIN, snap);
    expect(w2.snapshot()).toEqual(snap);
    w2.observe(obs());
    expect(w2.tick(T0 + 8 * MIN)).toEqual([]);
    expect(w2.tick(T0 + 9 * MIN)).toEqual([{ type: 'nudge' }]);
  });

  it('restore() replaces state and keeps wallclock from the original start', () => {
    const a = make();
    a.observe(obs());
    const snap = a.snapshot();
    const b = createWatchdog({}, () => T0 + 5 * 60 * MIN);
    b.restore(snap);
    expect(b.tick(T0 + 10 * 60 * MIN + 1)).toEqual([{ type: 'wallclock' }]);
  });

  it('snapshot is a copy', () => {
    const w = make();
    const s = w.snapshot();
    s.nudges = 99;
    s.abortedAt['x'] = 1;
    expect(w.snapshot().nudges).toBe(0);
    expect(w.snapshot().abortedAt).toEqual({});
  });
});

describe('progressMarker', () => {
  const ev = (id: string, state: 'todo' | 'running' | 'done', attempt = 0) => ({ id, state, attempt });

  it('is stable for identical input and order-insensitive for shas', () => {
    expect(progressMarker([ev('a', 'todo')], ['x', 'y'])).toBe(progressMarker([ev('a', 'todo')], ['y', 'x', 'x']));
  });

  it('changes on a new state transition', () => {
    expect(progressMarker([ev('a', 'todo')], [])).not.toBe(progressMarker([ev('a', 'todo'), ev('a', 'running')], []));
  });

  it('changes on a new attempt', () => {
    expect(progressMarker([ev('a', 'running', 0)], [])).not.toBe(progressMarker([ev('a', 'running', 0), ev('a', 'running', 1)], []));
  });

  it('ignores repeated identical events', () => {
    expect(progressMarker([ev('a', 'running')], [])).toBe(progressMarker([ev('a', 'running'), ev('a', 'running')], []));
  });

  it('changes on a new commit sha', () => {
    expect(progressMarker([], ['a'])).not.toBe(progressMarker([], ['a', 'b']));
  });
});
