"""Reads the soak log and decides whether the soak passed, against SPEC section 3.7."""

import json
from collections import Counter
from dataclasses import dataclass, field

# Hold(NO_DECISION), Rejected(PRICE_UNAVAILABLE), Rejected(PRICE_WIDE), and a CycleFailed
# that is only a worker run answering null. Executed is allowed: it is not a failure.
EXPECTED = {
    ("Hold", "NO_DECISION"), ("Rejected", "PRICE_UNAVAILABLE"), ("Rejected", "PRICE_WIDE"),
    ("CycleFailed", "NULL_RESULT"), ("Executed", None),
}


@dataclass
class Summary:
    cycles: int = 0
    skips: int = 0
    call_failures: int = 0
    errors: int = 0
    malformed: int = 0
    price_retries: int = 0
    min_cycles: int = 1
    outcomes: Counter = field(default_factory=Counter)
    unexpected: list = field(default_factory=list)

    @property
    def passed(self):
        return not self.unexpected and not self.malformed and self.cycles >= self.min_cycles


def unexpected_reason(record):
    if record.get("stuck") or record.get("final_stage") == "Stuck":
        return "Stuck"
    key = (record.get("result"), record.get("code"))
    if key in EXPECTED:
        return None
    # The bot does not send an execute it knows the oracle would refuse, so a price outage
    # that outlasts the decision ends in EXPIRED, which is PRICE_UNAVAILABLE by another road.
    if key == ("CycleFailed", "EXPIRED") and (record.get("price_skips") or record.get("price_retries")):
        return None
    return f"{key[0]}({key[1]})" if key[1] else str(key[0])


def summarize_log(lines, min_cycles=1):
    summary = Summary(min_cycles=min_cycles)
    for raw in lines:
        if not raw.strip():
            continue
        try:
            record = json.loads(raw)
            kind = record["kind"]
        except (ValueError, KeyError, TypeError):
            summary.malformed += 1
            continue
        if kind == "skip":
            summary.skips += 1
        elif kind == "call_failed":
            summary.call_failures += 1
        elif kind == "error":
            summary.errors += 1
        elif kind == "cycle":
            summary.cycles += 1
            summary.price_retries += record.get("price_retries", 0)
            code = record.get("code")
            summary.outcomes[f"{record.get('result')}({code})" if code else str(record.get("result"))] += 1
            reason = unexpected_reason(record)
            if reason:
                summary.unexpected.append({"nonce": record.get("nonce"), "reason": reason})
    return summary


def render(summary):
    out = [f"Siklus: {summary.cycles}   skip: {summary.skips}   panggilan gagal: {summary.call_failures}"
           f"   RPC gagal: {summary.errors}   PRICE_UNAVAILABLE diulang: {summary.price_retries}"]
    out += [f"  {name}: {count}" for name, count in sorted(summary.outcomes.items())]
    if summary.malformed:
        out.append(f"Baris log rusak: {summary.malformed}")
    if summary.cycles < summary.min_cycles:
        out.append(f"Siklus kurang dari minimum ({summary.cycles} < {summary.min_cycles})")
    out += [f"Tak terduga: nonce {u['nonce']} {u['reason']}" for u in summary.unexpected]
    out.append("Soak: LULUS" if summary.passed else "Soak: GAGAL")
    return "\n".join(out)
