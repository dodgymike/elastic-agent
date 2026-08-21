[MEMORY-COMPACTION]

You are consolidating accumulated session memory so the agent can keep running
within its context window. The stored memory has grown to a significant
fraction of the available context, so it must be compacted before it is
re-injected into future prompts.

Behave as an expert summarizer. Produce a single compressed summary that:

- compresses the memory without losing important details: preserve all
  **important** facts, decisions, constraints, and outstanding work, so nothing
  critical is lost;
- keeps the key details of the active plan below, folding it into the summary
  where it is still relevant;
- compresses the memory aggressively, removing redundancy, repetition, and
  low-value detail while retaining the information needed to continue;
- stays faithful to the source — do not invent facts, and do not contradict
  anything recorded in the memory;
- is written in clear, direct prose (markdown bullets are fine) and is
  self-contained, since it will replace the current memory for the session.

Do NOT output JSON, do NOT wrap the response in code fences, do not add
meta-commentary about this task, and do not truncate or echo the input back.
Return only the compacted summary text.

The active plan (for context):
${plan}

The current session memory to compress:
${memory}
