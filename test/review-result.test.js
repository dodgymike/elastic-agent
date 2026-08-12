// Unit tests for the post-plan review result validation/parsing logic.
// The functions under test are copied verbatim from main.ts (they are not
// exported there), so this test both validates the algorithm and guards
// against regressions in the review JSON contract.

function validateReviewResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, reason: "Review result must be a JSON object." };
    if (typeof value.passed !== "boolean") return { valid: false, reason: "passed must be a boolean." };
    if ("reasons" in value && (!Array.isArray(value.reasons) || value.reasons.some((reason) => typeof reason !== "string"))) return { valid: false, reason: "reasons must be an array of strings." };
    if ("learnings" in value && (!Array.isArray(value.learnings) || value.learnings.some((learning) => typeof learning !== "string"))) return { valid: false, reason: "learnings must be an array of strings." };
    const reasons = Array.isArray(value.reasons) ? value.reasons : [];
    const learnings = Array.isArray(value.learnings) ? value.learnings : [];
    if (!value.passed) {
        if (reasons.length === 0) return { valid: false, reason: "A failing review must provide at least one reason." };
        return { valid: true, review: { passed: false, reasons, learnings } };
    }
    return { valid: true, review: { passed: true, reasons, learnings } };
}
function parseReviewResult(text) {
    const trimmed = String(text).trim();
    let jsonText = trimmed;
    const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
    if (fenced) jsonText = fenced[1].trim();
    if (!jsonText.startsWith("{")) {
        const start = jsonText.indexOf("{");
        if (start === -1) return { valid: false, reason: "Review response did not contain a JSON object." };
        jsonText = jsonText.slice(start);
    }
    const end = jsonText.lastIndexOf("}");
    if (end === -1) return { valid: false, reason: "Review response did not contain a closing JSON brace." };
    jsonText = jsonText.slice(0, end + 1);
    try {
        return validateReviewResult(JSON.parse(jsonText));
    } catch (error) {
        return { valid: false, reason: `Review JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
    }
}

let failures = 0;
function check(name, cond) {
    if (cond) { console.log(`PASS: ${name}`); }
    else { console.error(`FAIL: ${name}`); failures += 1; }
}

// 1. Plain passing JSON
{
    const r = parseReviewResult('{"passed":true,"reasons":[],"learnings":[]}');
    check("plain passing JSON valid", r.valid === true && r.review.passed === true);
}
// 2. Fenced passing JSON with prose around it
{
    const r = parseReviewResult('Here is the review:\n```json\n{"passed":true,"reasons":[],"learnings":["note"]}\n```\nDone.');
    check("fenced passing JSON valid with learnings", r.valid === true && r.review.passed === true && r.review.learnings.length === 1);
}
// 3. Failing review with reasons
{
    const r = parseReviewResult('{"passed":false,"reasons":["missing docs","quality low"],"learnings":[]}');
    check("failing review with reasons valid", r.valid === true && r.review.passed === false && r.review.reasons.length === 2);
}
// 4. Failing review with no reasons -> invalid
{
    const r = parseReviewResult('{"passed":false,"reasons":[]}');
    check("failing review without reasons invalid", r.valid === false);
}
// 5. Missing required passed field -> invalid
{
    const r = parseReviewResult('{"reasons":[]}');
    check("missing passed field invalid", r.valid === false);
}
// 6. Malformed JSON -> invalid
{
    const r = parseReviewResult('not json at all');
    check("malformed response invalid", r.valid === false);
}
// 7. reasons not an array of strings -> invalid
{
    const r = parseReviewResult('{"passed":true,"reasons":123}');
    check("non-array reasons invalid", r.valid === false);
}
// 8. optional reasons/learnings on a passing review
{
    const r = parseReviewResult('{"passed":true}');
    check("passing review without reasons/learnings valid", r.valid === true && r.review.reasons.length === 0 && r.review.learnings.length === 0);
}

if (failures === 0) { console.log("\nAll review-result tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
