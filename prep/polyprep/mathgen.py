"""Generated math problems with answers computed in code (spec §4.3, amended 2026-10-12): the math suite when no contest problem qualifies.

Each kind is sized so that a plain loop or sieve to N does not fit run_python's limits (10 s, 512 MB) and a sublinear or vectorised method
only just does, so that a correct method can still fail on time, memory or an off-by-one. Every kind has a fast solver (used for the answers)
and a brute-force solver; tests check that they agree on small parameters. Calibration history: P0 (2026-10-12) put small brute-forceable
counts at ceiling (10/10); a second set (grid paths, digit DP, linear recurrences, bitmask DP; see git history) also went 18/18.
"""
from __future__ import annotations

import functools
import itertools
import math
import random

import numpy as np

MOD = 1_000_000_007
MOD_TEXT = "1000000007"
KINDS = ["totient_sum", "prime_sum", "squarefree_count", "coprime_pairs", "circle_points", "coprime_count"]
# Answers below this are redrawn: a zero or one-digit answer is too easy to guess.
MIN_ANSWER = 10
PRIMES = [p for p in range(2, 60) if all(p % q for q in range(2, int(p ** 0.5) + 1))]


# --- shared sieves (numpy) ---

def _primes_to(n: int) -> np.ndarray:
    sieve = np.ones(n + 1, dtype=bool)
    sieve[:2] = False
    for p in range(2, math.isqrt(n) + 1):
        if sieve[p]:
            sieve[p * p::p] = False
    return np.flatnonzero(sieve)


def _mobius_to(n: int) -> np.ndarray:
    mu = np.ones(n + 1, dtype=np.int8)
    mu[0] = 0
    for p in _primes_to(n):
        mu[p::p] *= -1
        if p * p <= n:
            mu[p * p::p * p] = 0
    return mu


def _phi_to(n: int) -> np.ndarray:
    phi = np.arange(n + 1, dtype=np.int64)
    for p in _primes_to(n):
        phi[p::p] -= phi[p::p] // p
    return phi


def _sublinear_prefix(n: int, small: np.ndarray, whole) -> dict:
    """F(v) for every v = n // k, where sum_{d=1}^{v} F(v // d) = whole(v) (Dirichlet convolution with 1). `small` is F on 0..L as a prefix array.
    Used for Mertens (whole = 1) and the totient sum (whole = v(v+1)/2)."""
    limit = len(small) - 1
    memo: dict[int, int] = {}
    values = sorted({n // k for k in range(1, math.isqrt(n) + 1)} | {k for k in range(1, math.isqrt(n) + 1)})
    for v in values:  # ascending, so every v // d needed is ready
        if v <= limit:
            continue
        total, d = whole(v), 2
        while d <= v:
            q = v // d
            hi = v // q
            total -= (hi - d + 1) * (int(small[q]) if q <= limit else memo[q])
            d = hi + 1
        memo[v] = total
    return memo


def _limit(n: int) -> int:
    return max(10, min(int(n ** (2 / 3)) + 1, 30_000_000))


# --- totient_sum: sum of phi(n) for n <= N, N ~ 1e10..1e11 ---

def totient_sum_fast(n: int) -> int:
    small = np.cumsum(_phi_to(min(n, _limit(n))))
    if n < len(small):
        return int(small[n]) % MOD
    return _sublinear_prefix(n, small, lambda v: v * (v + 1) // 2)[n] % MOD


def totient_sum_brute(n: int) -> int:
    return sum(sum(1 for k in range(1, m + 1) if math.gcd(k, m) == 1) for m in range(1, n + 1)) % MOD


def _totient_sum(rng: random.Random) -> tuple[str, int]:
    n = rng.randint(10 ** 10, 10 ** 11)
    text = (f"Euler's totient φ(n) counts the integers k with 1 ≤ k ≤ n and gcd(k, n) = 1. Let S = φ(1) + φ(2) + … + φ({n}). "
            f"What is S modulo {MOD_TEXT}?")
    return text, totient_sum_fast(n)


# --- prime_sum: sum of the primes <= N, N ~ 1e10..1e11 (Lucy_Hedgehog, O(N^3/4)) ---

def prime_sum_fast(n: int) -> int:
    r = math.isqrt(n)
    # S(v) = sum of 2..v, then sieve out composites prime by prime; all arithmetic mod MOD in int64.
    small = np.array([(v * (v + 1) // 2 - 1) % MOD for v in range(r + 1)], dtype=np.int64)
    small[0] = 0
    large = np.zeros(r + 2, dtype=np.int64)  # large[i] = S(n // i), i = 1..r
    for i in range(1, r + 1):
        v = n // i
        large[i] = (v % MOD) * ((v + 1) % MOD) % MOD * pow(2, MOD - 2, MOD) % MOD - 1
    large %= MOD
    for p in range(2, r + 1):
        if small[p] == small[p - 1]:
            continue
        sp, p2 = int(small[p - 1]), p * p
        k = min(r, n // p2)
        i = np.arange(1, k + 1, dtype=np.int64)
        ip = i * p
        sub = np.where(ip <= r, large[np.minimum(ip, r)], small[np.minimum(n // np.maximum(ip, 1), r)])
        large[1:k + 1] = (large[1:k + 1] - p * ((sub - sp) % MOD)) % MOD
        if p2 <= r:
            v = np.arange(r, p2 - 1, -1, dtype=np.int64)
            small[v] = (small[v] - p * ((small[v // p] - sp) % MOD)) % MOD
    return int(large[1]) if n > r else int(small[n])


def prime_sum_brute(n: int) -> int:
    return sum(p for p in range(2, n + 1) if all(p % q for q in range(2, math.isqrt(p) + 1))) % MOD


def _prime_sum(rng: random.Random) -> tuple[str, int]:
    n = rng.randint(10 ** 10, 10 ** 11)
    text = f"What is the sum of all primes p ≤ {n}, modulo {MOD_TEXT}?"
    return text, prime_sum_fast(n)


# --- squarefree_count: squarefree n <= N, N ~ 1e14..1e15 (sum of mu(d) * floor(N / d^2) for d <= sqrt N) ---

def squarefree_count_fast(n: int) -> int:
    r = math.isqrt(n)
    mu = _mobius_to(r).astype(np.int64)
    d = np.arange(r + 1, dtype=np.int64)
    d[0] = 1
    return int((mu * (n // (d * d)))[1:].sum())


def squarefree_count_brute(n: int) -> int:
    return sum(1 for m in range(1, n + 1) if all(m % (q * q) for q in range(2, math.isqrt(m) + 1)))


def _squarefree_count(rng: random.Random) -> tuple[str, int]:
    n = rng.randint(10 ** 14, 10 ** 15)
    text = f"An integer is squarefree if no square of a prime divides it. How many squarefree integers n satisfy 1 ≤ n ≤ {n}?"
    return text, squarefree_count_fast(n)


# --- coprime_pairs: pairs (a, b) in [1, A] x [1, B] with gcd 1, A, B ~ 1e10..1e11 (Mertens function at every floor value) ---

def coprime_pairs_fast(a: int, b: int) -> int:
    n = max(a, b)
    small = np.cumsum(_mobius_to(min(n, _limit(n))).astype(np.int64))
    memo = _sublinear_prefix(n, small, lambda v: 1)
    if a != b:
        memo.update(_sublinear_prefix(min(a, b), small, lambda v: 1))
    mertens = lambda v: int(small[v]) if v < len(small) else memo[v]
    total, d, m = 0, 1, min(a, b)
    while d <= m:
        hi = min(a // (a // d), b // (b // d))
        total += (mertens(hi) - mertens(d - 1)) * (a // d) * (b // d)
        d = hi + 1
    return total % MOD


def coprime_pairs_brute(a: int, b: int) -> int:
    return sum(1 for x in range(1, a + 1) for y in range(1, b + 1) if math.gcd(x, y) == 1) % MOD


def _coprime_pairs(rng: random.Random) -> tuple[str, int]:
    a, b = sorted((rng.randint(10 ** 10, 10 ** 11), rng.randint(10 ** 10, 10 ** 11)))
    text = f"How many ordered pairs of integers (a, b) with 1 ≤ a ≤ {a} and 1 ≤ b ≤ {b} satisfy gcd(a, b) = 1? Give the count modulo {MOD_TEXT}."
    return text, coprime_pairs_fast(a, b)


# --- circle_points: lattice points (x, y) with x^2 + y^2 <= N, N ~ 1e14..1e15 (sum of exact integer square roots) ---

def circle_points_fast(n: int) -> int:
    r = math.isqrt(n)
    total = 0
    for lo in range(0, r + 1, 5_000_000):
        x = np.arange(lo, min(lo + 5_000_000, r + 1), dtype=np.int64)
        v = n - x * x
        y = np.floor(np.sqrt(v.astype(np.float64))).astype(np.int64)
        y += (y + 1) * (y + 1) <= v  # float sqrt can be one off either way; correct it exactly
        y -= y * y > v
        assert ((y * y <= v) & ((y + 1) * (y + 1) > v)).all()
        total += int((2 * y + 1).sum()) * 2
    return total - (2 * r + 1)  # x = 0 was counted for +0 and -0


def circle_points_brute(n: int) -> int:
    r = math.isqrt(n)
    return sum(1 for x in range(-r, r + 1) for y in range(-r, r + 1) if x * x + y * y <= n)


def _circle_points(rng: random.Random) -> tuple[str, int]:
    n = rng.randint(10 ** 14, 10 ** 15)
    text = f"How many points (x, y) with integer coordinates satisfy x² + y² ≤ {n}?"
    return text, circle_points_fast(n)


# --- coprime_count: n <= N coprime to M in one residue class mod k (inclusion-exclusion over the squarefree divisors of M) ---

def coprime_count_fast(n: int, primes: list[int], k: int, r: int) -> int:
    total = 0
    for size in range(len(primes) + 1):
        for sub in itertools.combinations(primes, size):
            d = math.prod(sub)
            g = math.gcd(d, k)
            if r % g:
                continue
            kk = k // g  # d*t ≡ r (mod k)  <=>  t ≡ t0 (mod kk); d/g is coprime to kk because d is squarefree
            t0 = (r // g) * pow(d // g, -1, kk) % kk if kk > 1 else 0
            hi = n // d
            cnt = hi // kk if t0 == 0 else (0 if hi < t0 else (hi - t0) // kk + 1)
            total += (-1) ** size * cnt
    return total


def coprime_count_brute(n: int, primes: list[int], k: int, r: int) -> int:
    m = math.prod(primes)
    return sum(1 for x in range(1, n + 1) if math.gcd(x, m) == 1 and x % k == r)


def _coprime_count(rng: random.Random) -> tuple[str, int]:
    n = rng.randint(10 ** 12, 10 ** 13)
    primes = sorted(rng.sample(PRIMES, rng.randint(5, 7)))
    k = rng.randint(12, 60)
    r = rng.randint(0, k - 1)
    text = f"How many integers n with 1 ≤ n ≤ {n} satisfy gcd(n, {math.prod(primes)}) = 1 and n ≡ {r} (mod {k})?"
    return text, coprime_count_fast(n, primes, k, r)


DRAW = {"totient_sum": _totient_sum, "prime_sum": _prime_sum, "squarefree_count": _squarefree_count, "coprime_pairs": _coprime_pairs,
        "circle_points": _circle_points, "coprime_count": _coprime_count}


@functools.cache
def _draw(seed: int) -> tuple[str, str, str]:
    rng = random.Random(seed)
    kind = KINDS[seed % len(KINDS)]
    while True:
        text, ans = DRAW[kind](rng)
        if ans >= MIN_ANSWER:
            return kind, text, str(ans)


def generated(seed: int) -> dict:
    """Deterministic per seed: the kind is fixed by the seed; parameters are redrawn from the same rng until the answer is at least MIN_ANSWER.
    Cached, because some kinds take seconds to solve."""
    kind, text, ans = _draw(seed)
    return {"id": f"gen-{seed:03d}", "problem": text, "answer": ans, "kind": kind}
