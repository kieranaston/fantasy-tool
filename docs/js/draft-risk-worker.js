import { computeRiskProbabilities } from "./draft-scoring.js?v=15";

self.onmessage = (event) => {
  const { jobId, args } = event.data || {};
  try {
    const goneProbById = computeRiskProbabilities(args);
    const out = {};
    for (const [id, prob] of goneProbById.entries()) out[id] = prob;
    self.postMessage({ jobId, ok: true, goneProbById: out });
  } catch (err) {
    self.postMessage({
      jobId,
      ok: false,
      error: err?.message || String(err),
    });
  }
};
