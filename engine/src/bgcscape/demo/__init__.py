"""Synthetic demo corpus generation, for evaluating the interface at
realistic scale. See synthetic.py — the data is fabricated and labels
itself as such everywhere it surfaces.
"""
from bgcscape.demo.synthetic import SYNTHETIC_SOURCE_NAME, generate_demo_corpus

__all__ = ["SYNTHETIC_SOURCE_NAME", "generate_demo_corpus"]
