import type { GateDef, GateName } from "./gate";
import { angleGate } from "./angle";
import { outlineGate } from "./outline";
import { topicGate } from "./topic";

// The answerable gates by name — what POST /runs/:id/gates/:gate validates against and
// GET /runs/:id renders options from. The draft gate has its own route (decision).
export const ANSWERABLE_GATES: Partial<Record<GateName, GateDef<unknown>>> = {
  topic: topicGate as GateDef<unknown>,
  angle: angleGate as GateDef<unknown>,
  outline: outlineGate as GateDef<unknown>,
};

export function answerableGate(name: string): GateDef<unknown> | undefined {
  return (ANSWERABLE_GATES as Record<string, GateDef<unknown> | undefined>)[name];
}
