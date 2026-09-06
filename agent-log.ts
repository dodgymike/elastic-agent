import { appendFileSync } from "node:fs";
import { redactMemoryText } from "./memory/privacy.js";

export interface AgentLogEvent {
    event: "plan" | "step";
    status: string;
    tldr: string;
    session: string;
    run: string;
    step?: number;
    steps?: readonly string[];
}
function concise(value: string, limit = 240): string {
    const text = redactMemoryText(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
/** One append per event keeps concurrent runs distinguishable; logging never fails a run. */
export function appendAgentLog(path: string, event: AgentLogEvent): boolean {
    try {
        const record = {
            timestamp: new Date().toISOString(),
            session: concise(event.session, 100), run: concise(event.run, 100),
            event: event.event, status: concise(event.status, 40),
            ...(event.step === undefined ? {} : { step: event.step }),
            tldr: concise(event.tldr),
            ...(event.steps === undefined ? {} : { steps: event.steps.map((step) => concise(step)) }),
        };
        appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
        return true;
    } catch { return false; }
}
