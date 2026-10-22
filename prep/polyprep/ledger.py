"""Seeded generator for the `ledger` suite: a trading company's 2024 records as prose documents.

Every agent can read every document, but reading all of them costs a multiple (the factor F, picked by calibration)
of one agent's budget, so one agent cannot cover the evidence and four can if they split it (spec §4.2).
"""
from __future__ import annotations

import datetime as dt
import random
import re
from collections import defaultdict
from dataclasses import dataclass, replace

from polyprep.tokens import Counter

GENERATOR_VERSION = "ledger-2"  # 2: numeric answers for every template

SUPPLIERS = ["Kessler AG", "Brandt Logistics", "Halvorsen & Daughters", "Marchetti Trading", "Okafor Freight", "Lindqvist Supply",
             "Duarte Hermanos", "Novak & Sons", "Ashworth Metals", "Tanaka Shoji", "Petrov Industrial", "Moreau Export"]
CITIES = ["Lyon", "Ghent", "Porto", "Gdansk", "Bilbao", "Turin", "Leipzig", "Aarhus", "Brno", "Graz", "Tampere", "Cork", "Utrecht", "Malmo"]
PRODUCTS = ["copper wire", "steel brackets", "ceramic insulators", "pump housings", "valve seals", "cable drums", "bearing kits", "fuse panels"]
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
# Filler must not contain digits, ids, supplier, city or product names, or the words "units" and "batch" (ledger_parse relies on that).
FILLER = [
    "The driver reported light traffic on the ring road.",
    "Customs paperwork was completed without remarks.",
    "The pallets were wrapped twice because rain was forecast.",
    "A forklift at the receiving dock was out of service for the morning.",
    "The receiving clerk countersigned the delivery note on arrival.",
    "Seals on the container were intact when it was opened.",
    "The consignment waited briefly at the gate for a security check.",
    "Two crates were restacked after a strap came loose in transit.",
    "The carrier's tracking feed lagged behind the truck for most of the trip.",
    "Unloading took longer than usual because the yard was crowded.",
    "The warehouse team logged the goods into the incoming zone first.",
    "A spot check found the labels legible and the packaging dry.",
    "The haulier asked for an earlier slot next time.",
    "Paper copies of the invoice travelled with the load.",
    "The dock supervisor noted a short delay at the weighbridge.",
    "The goods were moved to racking before the end of the shift.",
    "No damage was recorded on the condition report.",
    "The trailer was swept and returned the same afternoon.",
    "The route avoided the bridge works announced the week before.",
    "The temperature log stayed within the agreed range.",
    "A replacement driver took over at the border crossing.",
    "Handling instructions were printed on every outer carton.",
    "The night shift confirmed the count against the manifest.",
    "Stacking height limits were respected throughout.",
    "The receiving bay was cleaned before the trailer reversed in.",
    "Shrink wrap on one pallet was patched at the dock.",
    "The transport planner flagged the trip as routine.",
    "The delivery window was met with time to spare.",
    "A photo of the open trailer was attached to the file.",
    "The quality team saw no need for a second inspection.",
    "A short rain shower passed while the doors were open.",
    "The scanner at the gate read every label on the first try.",
    "Drivers swapped paperwork in the canteen before the next run.",
    "The loading ramp was adjusted to match the trailer floor.",
    "A supervisor walked the length of the consignment before signing.",
    "The pallet jack needed a fresh battery halfway through unloading.",
    "Weather on the route stayed dry and calm.",
    "The inbound lane was cleared ten minutes ahead of the arrival.",
    "Nobody from the buyer's side was present at the handover.",
    "The shipping clerk filed the carbon copy in the tray.",
    "Lighting in the receiving area was replaced the previous week.",
    "The customs officer waved the vehicle through after a glance.",
    "Packing tape on two cartons was reinforced before storage.",
    "The foreman reminded the crew about the new gloves policy.",
    "Radio contact with the driver was clear for the whole trip.",
    "The gate log shows the vehicle entering and leaving on schedule.",
    "A forklift operator moved the empty pallets to the side.",
    "The consignment note was stamped at the weighbridge.",
    "Dust sheets were laid over the stack for the night.",
    "The driver took the mandatory rest break at the halfway point.",
]
MEMO_TOPICS = ["Office move", "Parking rules", "Holiday rota", "Printer replacement", "Canteen hours", "Safety briefing", "Visitor badges", "Archive cleanup"]


@dataclass(frozen=True)
class Shipment:
    id: str
    date: dt.date
    supplier: str
    product: str
    batch: str
    city: str
    qty: int


@dataclass(frozen=True)
class Correction:
    shipment: str
    field: str  # "city" | "qty"
    old: str | int
    new: str | int
    date: dt.date


@dataclass(frozen=True)
class Transfer:
    old: str
    new: str
    date: dt.date


@dataclass(frozen=True)
class Records:
    shipments: list[Shipment]
    recalls: list[str]
    corrections: list[Correction]
    transfers: list[Transfer]


@dataclass(frozen=True)
class Question:
    template: str
    text: str
    answer: str
    match: str


@dataclass(frozen=True)
class World:
    records: Records
    question: Question
    docs: list[tuple[str, str, str]]
    tokens: int
    shipments: int
    attempts: int = 0  # extra worlds tried before a question was valid (0 = first world)


def fmt(d: dt.date) -> str:
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def build(seed: int, n: int) -> Records:
    rng = random.Random(seed)
    suppliers = rng.sample(SUPPLIERS, 8)
    cities = rng.sample(CITIES, 10)
    products = rng.sample(PRODUCTS, 5)
    # Batch ids are shuffled over the (supplier, product) slots, so an id says nothing about its supplier.
    ids = [f"B-{i + 1:03d}" for i in range(2 * len(suppliers) * len(products))]
    rng.shuffle(ids)
    batches: dict[tuple[str, str], list[str]] = {}
    for k, slot in enumerate((s, p) for s in suppliers for p in products):
        batches[slot] = [ids[2 * k], ids[2 * k + 1]]
    start = dt.date(2024, 1, 1)
    shipments = []
    for i in range(n):
        s, p = rng.choice(suppliers), rng.choice(products)
        shipments.append(Shipment(f"SH-{i + 1:04d}", start + dt.timedelta(days=rng.randint(0, 365)), s, p, rng.choice(batches[(s, p)]), rng.choice(cities), rng.randint(10, 500)))
    all_batches = [b for bs in batches.values() for b in bs]
    recalls = sorted(rng.sample(all_batches, max(1, len(all_batches) // 10)))
    corrections = []
    for s in rng.sample(shipments, max(2, n // 12)):
        when = min(s.date + dt.timedelta(days=rng.randint(5, 60)), dt.date(2024, 12, 31))
        if rng.random() < 0.5:
            corrections.append(Correction(s.id, "city", s.city, rng.choice([c for c in cities if c != s.city]), when))
        else:
            corrections.append(Correction(s.id, "qty", s.qty, rng.choice([q for q in range(10, 501) if q != s.qty]), when))
    olds = rng.sample(suppliers, 2)
    news = rng.sample([x for x in suppliers if x not in olds], 2)
    transfers = [Transfer(o, nw, dt.date(2024, 6, 1) + dt.timedelta(days=rng.randint(0, 182))) for o, nw in zip(olds, news)]
    return Records(shipments, recalls, corrections, transfers)


def effective(r: Records) -> list[Shipment]:
    by_id = {s.id: s for s in r.shipments}
    for c in sorted(r.corrections, key=lambda c: c.date):
        if c.shipment in by_id:
            by_id[c.shipment] = replace(by_id[c.shipment], **{c.field: c.new})
    recalled = set(r.recalls)
    return [s for s in by_id.values() if s.batch not in recalled]


def owner(r: Records, s: Shipment) -> str:
    for t in r.transfers:
        if s.supplier == t.old and s.date >= t.date:
            return t.new
    return s.supplier


Variant = str  # "corrections" | "recalls" | "transfers": which part of the records a lazy reader would ignore
VARIANTS: tuple[Variant, ...] = ("corrections", "recalls", "transfers")
MAX_MARGIN = 0.10  # A and C: (top - second) / top must not exceed this, so the race is close


def _scores(r: Records, template: str) -> dict[str, int]:
    """Per-candidate totals over the effective shipments: supplier (A), the single grand total (B), city (C)."""
    totals: dict[str, int] = defaultdict(int)
    for s in effective(r):
        key = {"A": owner(r, s) if template == "A" else "", "B": "total", "C": s.city}[template]
        totals[key] += s.qty
    return dict(totals)


def _argmax(scores: dict[str, int]) -> str:
    return max(scores.items(), key=lambda kv: (kv[1], kv[0]))[0]


def margin(r: Records, template: str) -> float | None:
    """(top - second) / top for A and C; None for B or when there are fewer than two candidates."""
    if template == "B":
        return None
    ranked = sorted(_scores(r, template).values(), reverse=True)
    return (ranked[0] - ranked[1]) / ranked[0] if len(ranked) > 1 and ranked[0] > 0 else None


def answer_of(r: Records, template: str) -> str:
    """The number asked for: the grand total (B), or the leading supplier's (A) or city's (C) total."""
    scores = _scores(r, template)
    return str(scores["total"]) if template == "B" else str(scores[_argmax(scores)])


def changes(r: Records, template: str) -> dict[Variant, bool]:
    """For each variant, whether ignoring that part of the records changes the answer (the total asked for)."""
    truth = answer_of(r, template)
    ignore = {"corrections": replace(r, corrections=[]), "recalls": replace(r, recalls=[]), "transfers": replace(r, transfers=[])}
    return {v: answer_of(ignore[v], template) != truth for v in VARIANTS}


# Every answer is a number: a name answer could be guessed by a team that makes several blind claims.
QUESTIONS = {
    "A": ("How many units did the supplier that delivered the most units receive credit for in 2024? Apply every correction, leave out shipments "
          "from recalled batches, and count a shipment made under a transferred contract on or after the transfer date for the supplier that took "
          "the contract over. Answer with a number.", "numeric"),
    "B": ("How many units were delivered in total in 2024, over all suppliers, products and cities? Apply every correction and leave out "
          "shipments from recalled batches. Answer with a number.", "numeric"),
    "C": ("How many units did the city that received the most units get in 2024? Apply every correction and leave out shipments from recalled "
          "batches. Answer with a number.", "numeric"),
}


def ask(r: Records, template: str, rng: random.Random) -> Question | None:
    """The question for these records, or None if the world is unsuitable (a tie or a wide race for the lead, or a lazy reading gives the same total)."""
    if template not in QUESTIONS:
        raise ValueError(template)
    scores = _scores(r, template)
    if not scores:
        return None
    if template != "B":
        ranked = sorted(scores.values(), reverse=True)
        if len(ranked) < 2 or ranked[0] == ranked[1] or (ranked[0] - ranked[1]) / ranked[0] > MAX_MARGIN:
            return None
    answer = answer_of(r, template)
    changed = changes(r, template)
    if not (changed["corrections"] or changed["recalls"] or (template == "A" and changed["transfers"])):
        return None
    text, match = QUESTIONS[template]
    return Question(template, text, answer, match)


def _filler(rng: random.Random, lo: int, hi: int) -> str:
    return " ".join(rng.sample(FILLER, rng.randint(lo, hi)))


GAP_TOKENS = 40  # filler between two facts of a shipment has at least this many \w+ tokens, beyond the 24-token search snippet


def _gap(rng: random.Random, pool: list[str]) -> list[str]:
    """4-6 sentences from the pool (removed from it) with at least GAP_TOKENS word tokens in all."""
    while True:
        picked = rng.sample(pool, rng.randint(4, 6))
        if len(re.findall(r"\w+", " ".join(picked))) >= GAP_TOKENS:
            for f in picked:
                pool.remove(f)
            return picked


def _shipment_body(s: Shipment, rng: random.Random) -> str:
    """Six facts (date, supplier, quantity, product, batch, city), one per sentence, in random order, each pair at least GAP_TOKENS apart."""
    d = fmt(s.date)
    facts = [
        rng.choice([f"Shipment {s.id} was logged on {d}.", f"The record for shipment {s.id} is dated {d}.", f"Logged on {d} as shipment {s.id}."]),
        rng.choice([f"The supplier was {s.supplier}.", f"It was shipped by {s.supplier}.", f"{s.supplier} was the shipping supplier."]),
        rng.choice([f"It carried {s.qty} units.", f"The load held {s.qty} units.", f"{s.qty} units were on board."]),
        rng.choice([f"The goods were {s.product}.", f"The cargo consisted of {s.product}.", f"The product shipped was {s.product}."]),
        rng.choice([f"They came from batch {s.batch}.", f"The batch reference was {s.batch}.", f"The goods were taken from batch {s.batch}."]),
        rng.choice([f"The destination was {s.city}.", f"It was delivered to {s.city}.", f"{s.city} was the receiving city."]),
    ]
    rng.shuffle(facts)
    pool = list(FILLER)
    sentences = rng.sample(pool, rng.randint(0, 2))
    for f in sentences:
        pool.remove(f)
    for i, fact in enumerate(facts):
        sentences.append(fact)
        if i < len(facts) - 1:
            sentences.extend(_gap(rng, pool))
    sentences.extend(rng.sample(pool, rng.randint(0, 2)))
    return " ".join(sentences)


def render(r: Records, rng: random.Random) -> list[tuple[str, str, str]]:
    docs: list[tuple[str, str]] = []
    for s in r.shipments:
        docs.append((f"Shipment record {s.id}", _shipment_body(s, rng)))
    for c in r.corrections:
        what = f"was delivered to {c.new}, not {c.old}" if c.field == "city" else f"carried {c.new} units, not {c.old}"
        docs.append((f"Correction to {c.shipment}", f"Correction issued {fmt(c.date)}: shipment {c.shipment} {what} as first recorded. {_filler(rng, 2, 4)}"))
    for b in r.recalls:
        docs.append((f"Recall notice for {b}", f"Recall notice: batch {b} is withdrawn. Every shipment from batch {b} is void for delivery statistics. {_filler(rng, 2, 4)}"))
    for t in r.transfers:
        docs.append((f"Contract transfer: {t.old}", f"Contract transfer: from {fmt(t.date)}, {t.new} took over all contracts of {t.old}. Shipments under those contracts on or after that date count for {t.new}. {_filler(rng, 2, 4)}"))
    for _ in range(max(3, len(r.shipments) // 10)):
        docs.append((f"Memo: {rng.choice(MEMO_TOPICS)}", _filler(rng, 6, 10)))
    rng.shuffle(docs)
    return [(f"D-{i + 1:04d}", title, body) for i, (title, body) in enumerate(docs)]


MAX_ATTEMPTS = 200


def _world(seed: int, n: int) -> tuple[Records, Question, int]:
    template = "ABC"[seed % 3]
    for attempt in range(MAX_ATTEMPTS):
        r = build(seed if attempt == 0 else seed * 1000 + attempt, n)
        q = ask(r, template, random.Random(seed * 31 + attempt))
        if q is not None:
            return r, q, attempt
    raise RuntimeError(f"ledger seed {seed}: no valid question after {MAX_ATTEMPTS} worlds")


def generate(seed: int, target_tokens: int, count: Counter) -> World:
    """A world whose documents cost about target_tokens to read (within 5% when the shipment count allows)."""
    n = 60
    for _ in range(8):
        r, q, attempts = _world(seed, n)
        docs = render(r, random.Random(seed * 7919 + n))
        tokens = sum(count(t) + count(b) for _, t, b in docs)
        if abs(tokens - target_tokens) / target_tokens <= 0.05:
            break
        n = max(20, round(n * target_tokens / tokens))
    return World(r, q, docs, tokens, len(r.shipments), attempts)


def prompt(question: str) -> str:
    return ("The documents in this collection are the 2024 records of a trading company: shipments, corrections, recall notices, contract "
            "transfers and memos. search(query) finds documents by keywords, read_doc(id, page) reads one, and list_docs(page) lists them all "
            f"in order.\n\nQuestion: {question}")
