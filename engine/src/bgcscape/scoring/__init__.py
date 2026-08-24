"""BGC prioritization scoring (report §8).

A **prioritization score** — an ordinal hint for deciding which clusters
to examine first. Never a novelty claim, never a probability. See
prioritization.py's module docstring for the three design properties that
follow from that, especially: missing evidence is never scored as
evidence.
"""
from bgcscape.scoring.prioritization import (
    DEFAULT_WEIGHTS,
    MIN_COMPONENTS_FOR_SCORE,
    NOT_A_NOVELTY_CLAIM,
    SCORE_IS_ORDINAL,
    WEIGHTS_ARE_UNCALIBRATED,
    ComponentScore,
    PrioritizationResult,
    ScoringContext,
    build_scoring_context,
    rank_bgcs,
    score_bgc,
)

__all__ = [
    "DEFAULT_WEIGHTS",
    "MIN_COMPONENTS_FOR_SCORE",
    "NOT_A_NOVELTY_CLAIM",
    "SCORE_IS_ORDINAL",
    "WEIGHTS_ARE_UNCALIBRATED",
    "ComponentScore",
    "PrioritizationResult",
    "ScoringContext",
    "build_scoring_context",
    "rank_bgcs",
    "score_bgc",
]
