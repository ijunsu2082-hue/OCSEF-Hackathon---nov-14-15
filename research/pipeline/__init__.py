"""Ingestion pipeline for the research datasets.

Run from ``research/`` as ``python -m pipeline {fetch,validate,manifest,publish,compat,all}``.
Stdlib only at runtime (pandas is allowed by the contract but not needed here).
"""

__all__ = ["common", "validate", "compat", "manifest", "publish"]
