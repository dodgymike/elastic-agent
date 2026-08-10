# Local durable-memory prototype (step 6)

`prototype.js` is a local Node prototype of the chosen snapshot/JSONL layout. It provides initialization, canonical serialization/digests, validated replay, atomic manifest replacement, operation replay (`add_node`, `add_provenance`, `add_edge`, `update_node`), bounded unsafe-text rejection, deterministic retrieval, and compatible-claim consolidation.

This is deliberately **not wired into `main2.js`**, does not read legacy memory, and does not import operational state. It is a testable tooling boundary only. It has no process lock, authorization service, full policy detector, checkpoint compaction, migration command, or production CLI; those remain implementation hardening/adoption work.

Run executable fixtures with `node test/durable-memory-prototype.test.js`.
