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
    untriggered: int = 0
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


def is_stuck(record):
    return bool(record.get("stuck") or record.get("final_stage") == "Stuck")


def is_untriggered(record):
    """A cycle the bot found already running and took over: it has no transaction of its own, so
    its outcome cannot be read and is `Unknown`. One it saw go Stuck is still a failure, and so is
    one where a call of the bot failed: that is the bot's own problem, not someone else's cycle."""
    return (bool(record.get("resumed")) and not record.get("txs") and not record.get("failed_calls")
            and not is_stuck(record))


def unexpected_reason(record):
    if is_stuck(record):
        return "Stuck"
    key = (record.get("result"), record.get("code"))
    if key in EXPECTED:
        return None
    # A price outage that outlasts decision_ttl: every execute is rejected PRICE_UNAVAILABLE
    # until the decision expires. Any call that failed on its own breaks that reading.
    if key == ("CycleFailed", "EXPIRED") and record.get("price_retries") and not record.get("failed_calls"):
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
            if is_untriggered(record):
                summary.untriggered += 1
                continue
            summary.cycles += 1
            summary.price_retries += record.get("price_retries", 0)
            code = record.get("code")
            summary.outcomes[f"{record.get('result')}({code})" if code else str(record.get("result"))] += 1
            reason = unexpected_reason(record)
            if reason:
                summary.unexpected.append({"nonce": record.get("nonce"), "reason": reason})
    return summary


def render(summary):
    out = [f"Cycles: {summary.cycles}   skips: {summary.skips}   failed calls: {summary.call_failures}"
           f"   RPC errors: {summary.errors}   PRICE_UNAVAILABLE retried: {summary.price_retries}"]
    out += [f"  {name}: {count}" for name, count in sorted(summary.outcomes.items())]
    if summary.untriggered:
        out.append(f"Cycles the bot did not trigger (not counted, not judged): {summary.untriggered}")
    if summary.malformed:
        out.append(f"Malformed log lines: {summary.malformed}")
    if summary.cycles < summary.min_cycles:
        out.append(f"Fewer cycles than the minimum ({summary.cycles} < {summary.min_cycles})")
    out += [f"Unexpected: nonce {u['nonce']} {u['reason']}" for u in summary.unexpected]
    if summary.call_failures:
        out.append(f"Warning: failed calls: {summary.call_failures} (see the call_failed lines in the log)")
    out.append("Soak: PASS" if summary.passed else "Soak: FAIL")
    return "\n".join(out)
