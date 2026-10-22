"""Data preparation for the polylogue task suites. Writes only under data/ (git-ignored)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
