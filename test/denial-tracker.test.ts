// Unit tests for denial-tracker.ts: the fighting-with-classifier counter that
// detects repeated classifier denials for the same goal and issues a replan
// directive instead of letting the agent hammer the blocked call.
// Compiled and executed standalone by the `test:denial-tracker` npm script.
import {
  DenialTracker,
  DENIAL_REPLAN_THRESHOLD,
} from "../denial-tracker.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

async function main(): Promise<void> {
  try {
    // ------------------------------------------------------------------
    // 1. No denials: no counter, never flagged as fighting.
    // ------------------------------------------------------------------
    {
      const tracker = new DenialTracker();
      check("fresh tracker has count 0 for a goal", tracker.countFor("step-1") === 0);
      check("fresh tracker is not fighting", !tracker.hasFought());
      check("fresh tracker has no active goal", tracker.currentGoal() === null);
      check("default threshold is 2", DENIAL_REPLAN_THRESHOLD === 2);
    }

    // ------------------------------------------------------------------
    // 2. Single denial does NOT trigger a replan directive.
    // ------------------------------------------------------------------
    {
      const tracker = new DenialTracker();
      const first = tracker.recordDenial("step-1", "Read", "data.json is protected");
      check("single denial has count 1", first.count === 1);
      check("single denial is below threshold", !first.thresholdReached);
      check("single denial yields no directive", first.replanDirective === null);
      check("tracker not fighting after one denial", !tracker.hasFought());
    }

    // ------------------------------------------------------------------
    // 3. Repeated denials for the same goal trigger a replan directive.
    // ------------------------------------------------------------------
    {
      const tracker = new DenialTracker();
      tracker.recordDenial("step-1", "Read", "data.json is protected");
      const second = tracker.recordDenial("step-1", "Read", "data.json is protected");
      check("second denial count is 2", second.count === 2);
      check("second denial reaches threshold", second.thresholdReached);
      check(
        "second denial returns a replan directive",
        second.replanDirective !== null && /REPLAN DIRECTIVE/i.test(second.replanDirective),
      );
      check(
        "directive states the action was not allowed",
        second.replanDirective !== null && /NOT allowed/i.test(second.replanDirective),
      );
      check(
        "directive suggests re-planning",
        second.replanDirective !== null && /re-plan/i.test(second.replanDirective),
      );
      check("tracker is fighting after threshold", tracker.hasFought());
      check("active goal is step-1", tracker.currentGoal() === "step-1");
    }

    // ------------------------------------------------------------------
    // 4. Directives persist on further denials without resetting.
    // ------------------------------------------------------------------
    {
      const tracker = new DenialTracker();
      tracker.recordDenial("goal", "Git", "force-push denied");
      tracker.recordDenial("goal", "Git", "force-push denied");
      const third = tracker.recordDenial("goal", "Git", "force-push denied");
      check("third denial still reaches threshold", third.thresholdReached);
      check("third denial count is 3", third.count === 3);
    }

    // ------------------------------------------------------------------
    // 5. Progress (success) resets the counter for that goal.
    // ------------------------------------------------------------------
    {
      const tracker = new DenialTracker();
      tracker.recordDenial("step-1", "Read", "protected");
      check("count 1 before success", tracker.countFor("step-1") === 1);
      tracker.recordSuccess("step-1");
      check("count resets to 0 after success", tracker.countFor("step-1") === 0);
      // Not yet fighting after a reset.
      check("not fighting after reset", !tracker.hasFought());
      // A new denial starts counting afresh.
      const again = tracker.recordDenial("step-1", "Read", "protected");
      check("fresh start count 1 after reset", again.count === 1);
    }

    // ------------------------------------------------------------------
    // 6. Explicit reset / resetAll clear counters.
    // ------------------------------------------------------------------
    {
      const tracker = new DenialTracker();
      tracker.recordDenial("a", "Read", "x");
      tracker.recordDenial("a", "Read", "x");
      check("count 2 before reset", tracker.countFor("a") === 2);
      tracker.reset("a");
      check("count 0 after reset(goal)", tracker.countFor("a") === 0);

      tracker.recordDenial("a", "Read", "x");
      tracker.recordDenial("a", "Read", "x");
      tracker.recordDenial("b", "Write", "y");
      check("two goals recorded", tracker.countFor("a") === 2 && tracker.countFor("b") === 1);
      tracker.resetAll();
      check("resetAll clears all goals", tracker.countFor("a") === 0 && tracker.countFor("b") === 0);
      check("resetAll clears active goal", tracker.currentGoal() === null);
      check("not fighting after resetAll", !tracker.hasFought());
    }

    // ------------------------------------------------------------------
    // 7. Per-goal separation: denials in a different goal do not conflate.
    // ------------------------------------------------------------------
    {
      const tracker = new DenialTracker();
      tracker.recordDenial("step-1", "Read", "a");
      tracker.recordDenial("step-2", "Read", "b");
      check("step-1 count independent", tracker.countFor("step-1") === 1);
      check("step-2 count independent", tracker.countFor("step-2") === 1);
      check("each goal alone below threshold", !tracker.hasFought());
    }

    // ------------------------------------------------------------------
    // 8. Serialization round-trips through toJSON/fromJSON.
    // ------------------------------------------------------------------
    {
      const tracker = new DenialTracker();
      tracker.recordDenial("step-1", "Write", "secret file blocked");
      tracker.recordDenial("step-1", "Write", "secret file blocked");
      const state = tracker.toJSON();
      const restored = new DenialTracker(DENIAL_REPLAN_THRESHOLD, state);
      check("restored count matches", restored.countFor("step-1") === 2);
      check("restored is fighting", restored.hasFought());
      check("restored active goal matches", restored.currentGoal() === "step-1");
      const again = restored.recordDenial("step-1", "Write", "secret file blocked");
      check("restored continues counting", again.count === 3 && again.thresholdReached);
    }

    // ------------------------------------------------------------------
    // 9. Custom threshold is honored.
    // ------------------------------------------------------------------
    {
      const tracker = new DenialTracker(3);
      tracker.recordDenial("g", "Read", "x");
      const two = tracker.recordDenial("g", "Read", "x");
      check("custom threshold not reached at 2", !two.thresholdReached);
      const three = tracker.recordDenial("g", "Read", "x");
      check("custom threshold reached at 3", three.thresholdReached && three.replanDirective !== null);
    }

    // ------------------------------------------------------------------
    // 10. Invalid thresholds are rejected.
    // ------------------------------------------------------------------
    {
      let threw = false;
      try {
        // eslint-disable-next-line no-new
        new DenialTracker(0);
      } catch {
        threw = true;
      }
      check("non-positive threshold is rejected", threw);
    }
  } finally {
    if (failures > 0) {
      console.error(`denial-tracker test failed with ${failures} failure(s)`);
      process.exit(1);
    }
    console.log("All denial-tracker tests passed.");
  }
}

main();
