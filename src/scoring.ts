import type { Candidate } from "./types.js";

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
}

// Deterministic, cheap pre-score (0-100) computed purely from data already fetched
// (no extra API calls). This is NOT the final grade shown to the user — Claude does
// the real qualitative judgment on the top N this narrows things down to. Its only
// job is to stop the LLM call from having to wade through every survivor.

function scoreLiquidity(c: Candidate): number {
  const pts = ((c.liquidityUsd - 25_000) / (150_000 - 25_000)) * 20;
  return Math.max(0, Math.min(20, pts));
}

function scoreFlow(c: Candidate): number {
  const { buys, sells, buyers, sellers } = c.txnsH1;
  const total = buys + sells;
  if (total === 0) return 0;
  const buyRatio = buys / total;

  let pts: number;
  if (buyRatio <= 0.5) {
    pts = buyRatio * 24; // 0 at all-sells, 12 at balanced
  } else if (buyRatio <= 0.8) {
    pts = 12 + ((buyRatio - 0.5) / 0.3) * 8; // healthy buy-dominant zone: 12 -> 20
  } else {
    // Beyond 80% buys, taper back down. An extreme ratio (very few sells relative to
    // buys, e.g. a honeypot / can't-sell token) is suspicious, not "even more bullish".
    pts = 20 - ((buyRatio - 0.8) / 0.2) * 10; // 20 at 80%, 10 at 100%
  }

  // Buyer-diversity bonus only in a plausible organic range — not for the extreme
  // imbalance that's more likely a sell-restriction signature than real demand.
  if (buyers > sellers * 1.2 && buyers < sellers * 5) pts += 1;

  return Math.max(0, Math.min(20, pts));
}

function scoreMomentum(c: Candidate): number {
  const change = c.priceChangeH6 ?? 0;
  if (change < 0) return Math.max(0, 8 + change / 10);
  if (change < 10) return 8 + change * 0.4;
  if (change <= 150) return 20;
  if (change <= 300) return 20 - ((change - 150) / 150) * 12;
  return 5;
}

function scoreSafety(c: Candidate): number {
  if (!c.rugCheck) return 10;
  const scoreNorm = c.rugCheck.score_normalised ?? 50;
  let pts = 20 * (1 - Math.min(Math.max(scoreNorm, 0), 100) / 100);
  const dangerRisks = c.rugCheck.risks.filter((r) => r.level === "danger").length;
  pts -= dangerRisks * 5;
  if (c.rugCheck.token.mintAuthority) pts -= 5;
  if (c.rugCheck.token.freezeAuthority) pts -= 5;
  return Math.max(0, Math.min(20, pts));
}

function scoreAgeFit(c: Candidate): number {
  if (c.ageHours === null) return 10;
  if (c.ageHours <= 12) return 20;
  if (c.ageHours <= 72) return 20 - ((c.ageHours - 12) / 60) * 15;
  return 0;
}

/** Any RugCheck danger-level risk gates the whole score down hard — Claude still gets
 *  the full data and makes the real call, but a dangerous token shouldn't out-rank a
 *  clean one in the pre-cut just because its volume/momentum numbers look exciting. */
function hasDangerRisk(c: Candidate): boolean {
  return c.rugCheck?.risks.some((r) => r.level === "danger") ?? false;
}

export function scoreCandidate(c: Candidate): number {
  const raw = scoreLiquidity(c) + scoreFlow(c) + scoreMomentum(c) + scoreSafety(c) + scoreAgeFit(c);
  return hasDangerRisk(c) ? Math.min(raw, 25) : raw;
}

export function rankAndCut(candidates: Candidate[], topN: number): ScoredCandidate[] {
  return candidates
    .map((candidate) => ({ candidate, score: Math.round(scoreCandidate(candidate)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
