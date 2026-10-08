// How far a distribution's sum may stray from 1 and still count as rounding. Decision models
// round their probabilities when serializing them (Jev's can sum to 0.9998 or 1.0002), while
// DecisionModel accepts only 1e-6; anything further off is a wrong answer and still fails.
const ROUNDING_TOLERANCE = 0.05;

/**
 * Rescales a distribution over `labels` to sum to 1, counting labels the provider left out
 * as 0. Returns the input unchanged when the sum is off by more than rounding.
 */
export function normalizeDistribution(labels: readonly string[], probabilities: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const values = labels.map((label) => {
    const value = probabilities[label];
    return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || Math.abs(total - 1) > ROUNDING_TOLERANCE) return probabilities;
  return Object.fromEntries(labels.map((label, index) => [label, values[index]! / total]));
}
