Unit tests for the Debt Planner. From this folder:
  node --test tests/                          (progress, storage import validation, plan glue)
  PYTHONDONTWRITEBYTECODE=1 python3 tests/payoff/check.py   (the original payoff math checks, run against payoff.js here)
payoff.js is a byte for byte copy of the one on the public site.
