// Per-call cost computation → spend_ledger (FR-15.7, design §6/§10).
// Prices come from MODEL_REGISTRY (registry.ts); every adapter returns normalized Usage.
// TODO(phase-1): implement priceOf(usage, modelInfo) + ledger insert + month-to-date
// aggregates used by the gates (global $20 hard cap FR-15.10, per-user $10 FR-15.8).
export {};
