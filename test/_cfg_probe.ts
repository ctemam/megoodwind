/** Subprocess probe for bool_env_test — prints parsed config as JSON.
 *  Exit 1 + ZodError text when config load refuses (malformed booleans). */
export {};

const { cfg, armedFor } = await import('../src/config/index.js');
console.log(JSON.stringify({
  AUTO_EXECUTE: cfg.AUTO_EXECUTE,
  DIAG_ONLY: cfg.DIAG_ONLY,
  STRICT_PROFIT_FLOOR_GUARD: cfg.STRICT_PROFIT_FLOOR_GUARD,
  P09_ENABLED: cfg.P09_ENABLED,
  armedChains: cfg.armedChains,
  armedFor1: armedFor(1),
  armedFor56: armedFor(56),
  armedFor137: armedFor(137),
}));
