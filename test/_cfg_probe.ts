/** Subprocess probe for bool_env_test — prints parsed config as JSON.
 *  Exit 1 + ZodError text when config load refuses (malformed booleans). */
export {};

const { cfg, armedFor, BOOL_FIELDS } = await import('../src/config/index.js');
const flags = Object.fromEntries(BOOL_FIELDS.map((f) => [f, (cfg as unknown as Record<string, boolean>)[f]]));
console.log(JSON.stringify({
  ...flags,
  armedChains: cfg.armedChains,
  armedFor1: armedFor(1),
  armedFor56: armedFor(56),
  armedFor137: armedFor(137),
}));
