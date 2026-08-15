// Unit tests for loop-replan.ts: the loop-mode re-planning decision logic.
// Compiled and executed standalone. Covers extracting a new prompt from
// relevant messages, the bounded replan budget, and the fail-safe guard that
// decides whether it is safe to re-enter planning on top of preserved work.
import {
  DEFAULT_LOOP_REPLAN_MAX_ITERATIONS,
  MIN_LOOP_REPLAN_MAX_ITERATIONS,
  consumeReplanBudget,
  decideSafeReplan,
  extractReplanPrompt,
  initialLoopReplanBudget,
  resolveLoopReplanMaxIterations,
} from "../loop-replan.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------
  // 1. extractReplanPrompt turns relevant messages into the new prompt.
  // ---------------------------------------------------------------
  {
    const prompt = extractReplanPrompt([{ text: "please replan and add step 3" }]);
    check("extracts one message text", prompt === "please replan and add step 3");
  }
  {
    const prompt = extractReplanPrompt([
      "reset scope",
      { content: "and prioritize the frontend" },
    ]);
    check("concatenates multiple messages", /reset scope/.test(prompt) && /prioritize the frontend/.test(prompt));
  }
  {
    check("empty input yields empty prompt", extractReplanPrompt([]).length === 0);
    check("null/undefined messages are skipped", extractReplanPrompt([null, undefined]).length === 0);
  }

  // ---------------------------------------------------------------
  // 2. resolveLoopReplanMaxIterations resolves the bounded budget.
  // ---------------------------------------------------------------
  {
    check("default used when nothing configured", resolveLoopReplanMaxIterations() === DEFAULT_LOOP_REPLAN_MAX_ITERATIONS);
    check("explicit value honored", resolveLoopReplanMaxIterations(3) === 3);
    check("values below minimum are clamped to default", resolveLoopReplanMaxIterations(0) === DEFAULT_LOOP_REPLAN_MAX_ITERATIONS);
    check("non-numeric explicit falls back to default", resolveLoopReplanMaxIterations(Number.NaN) === DEFAULT_LOOP_REPLAN_MAX_ITERATIONS);
    check(
      "env override honored",
      resolveLoopReplanMaxIterations(undefined, "7") === 7,
    );
    check(
      "invalid env falls back to default",
      resolveLoopReplanMaxIterations(undefined, "not-a-number") === DEFAULT_LOOP_REPLAN_MAX_ITERATIONS,
    );
    check(
      "minimum env is >= MIN",
      resolveLoopReplanMaxIterations(undefined, "0") >= MIN_LOOP_REPLAN_MAX_ITERATIONS,
    );
  }

  // ---------------------------------------------------------------
  // 3. Budget: start at cap, consume decrements, never below zero.
  // ---------------------------------------------------------------
  {
    const initial = initialLoopReplanBudget();
    check("initial budget equals resolved cap", initial.remaining === DEFAULT_LOOP_REPLAN_MAX_ITERATIONS);
    const once = consumeReplanBudget(initial);
    check("consume decrements remaining", once.remaining === initial.remaining - 1);
    check("maxIterations preserved", once.maxIterations === initial.maxIterations);
    const exhausted = consumeReplanBudget({ remaining: 0, maxIterations: 1 });
    check("consume never goes below zero", exhausted.remaining === 0);
  }

  // ---------------------------------------------------------------
  // 4. decideSafeReplan: allow when main checkout is clean.
  // ---------------------------------------------------------------
  {
    const safe = decideSafeReplan({ mainCheckoutIsDirty: () => false, worktreeExists: () => true, worktreeHasWork: () => true });
    check("clean main + preserved worktree is safe", safe.safe === true);
  }
  {
    const safe = decideSafeReplan({ mainCheckoutIsDirty: () => false, worktreeExists: () => false });
    check("clean main with no worktree is safe (fresh worktree created)", safe.safe === true);
  }

  // ---------------------------------------------------------------
  // 5. decideSafeReplan: fail closed on a dirty/unknown main checkout.
  // ---------------------------------------------------------------
  {
    const dirty = decideSafeReplan({ mainCheckoutIsDirty: () => true });
    check("dirty main checkout blocks replanning", dirty.safe === false);
    check("dirty main checkout yields an actionable reason", /uncommitted changes/.test(dirty.reason));
  }
  {
    const unknown = decideSafeReplan({ mainCheckoutIsDirty: () => null });
    check("unknown main-checkout state blocks replanning (fail closed)", unknown.safe === false);
    check("unknown state yields an actionable reason", /cannot confirm/.test(unknown.reason));
  }
}

main().then(() => {
  if (failures > 0) {
    console.error(`loop-replan test failed with ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("All loop-replan tests passed.");
});
