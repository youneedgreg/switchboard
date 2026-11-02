/**
 * Stops sending traffic to a provider that keeps failing, so requests fail over
 * immediately instead of each spending its retries and deadlines finding out.
 *
 * closed → open: too many failures in the window.
 * open → half-open: the cooldown has passed; one probe request is let through.
 * half-open → closed if the probe succeeds, → open if it fails. A probe that
 * never reports back, such as when its client leaves, loses its lease so that
 * another request can probe.
 */
export type CircuitState = "closed" | "open" | "half_open";
export type CircuitOutcome = "success" | "failure";

export type CircuitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface CircuitBreaker {
  allow(provider: string): Promise<CircuitDecision>;
  record(provider: string, outcome: CircuitOutcome): Promise<void>;
  state(provider: string): Promise<CircuitState>;
}

export interface CircuitBreakerConfig {
  /** Failures needed in the window before the circuit can open. */
  minFailures: number;
  /** Share of the window's calls that must have failed. */
  failureRatio: number;
  windowMs: number;
  cooldownMs: number;
  probeLeaseMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  minFailures: 5,
  failureRatio: 0.5,
  windowMs: 30_000,
  cooldownMs: 30_000,
  probeLeaseMs: 30_000,
};

interface Circuit {
  state: CircuitState;
  failures: number;
  successes: number;
  windowStart: number;
  /** While open: when probing may start. While half-open: when the lease ends. */
  until: number;
}

/**
 * One instance's view, for tests and for running without Redis. The Redis
 * version in redis-stores.ts implements the same transitions, and both are held
 * to the same contract tests.
 */
export function inMemoryCircuitBreaker(
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER,
  now: () => number = Date.now,
): CircuitBreaker {
  const circuits = new Map<string, Circuit>();

  const circuitFor = (provider: string): Circuit => {
    let circuit = circuits.get(provider);
    if (!circuit) {
      circuit = { state: "closed", failures: 0, successes: 0, windowStart: now(), until: 0 };
      circuits.set(provider, circuit);
    }
    return circuit;
  };

  const reset = (circuit: Circuit, state: CircuitState, until = 0) => {
    Object.assign(circuit, { state, failures: 0, successes: 0, windowStart: now(), until });
  };

  return {
    async allow(provider) {
      const circuit = circuitFor(provider);
      if (circuit.state === "closed") return { allowed: true };
      const time = now();
      if (time < circuit.until) return { allowed: false, retryAfterMs: circuit.until - time };
      circuit.state = "half_open";
      circuit.until = time + config.probeLeaseMs;
      return { allowed: true };
    },
    async record(provider, outcome) {
      const circuit = circuitFor(provider);
      if (circuit.state === "open") return;
      if (circuit.state === "half_open") {
        if (outcome === "success") reset(circuit, "closed");
        else reset(circuit, "open", now() + config.cooldownMs);
        return;
      }
      if (now() >= circuit.windowStart + config.windowMs) reset(circuit, "closed");
      if (outcome === "success") {
        circuit.successes++;
        return;
      }
      circuit.failures++;
      const calls = circuit.failures + circuit.successes;
      if (
        circuit.failures >= config.minFailures &&
        circuit.failures / calls >= config.failureRatio
      ) {
        reset(circuit, "open", now() + config.cooldownMs);
      }
    },
    async state(provider) {
      return circuitFor(provider).state;
    },
  };
}
