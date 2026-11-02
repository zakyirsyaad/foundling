import json
import re
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ATTACK_PY = ROOT / "tools" / "attack.py"
FOUNDLING = ROOT / "tools" / "foundling"
REGISTRY = ROOT / "tools" / "attack-registry.json"
SPEC = ROOT / "docs" / "SPEC.md"

CORE_ATTACKS = [
    "over-cap",
    "drip",
    "replay",
    "bad-route",
    "stale-price",
    "kill-agent",
    "governor-loosen",
    "double-redeem",
    "forged-caller",
    "freeze-race",
    "inflated-nav",
    "deflated-sell",
    "never-flat",
    "setup-spam",
    "advance-race",
]


def run(*args, attacks_dir=None, registry=None):
    cmd = [sys.executable, str(ATTACK_PY)]
    if registry:
        cmd += ["--registry", str(registry)]
    if attacks_dir:
        cmd += ["--attacks-dir", str(attacks_dir)]
    cmd += list(args)
    return subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)


def load_registry():
    return json.loads(REGISTRY.read_text())["attacks"]


def make_script(directory, name, exit_code):
    path = directory / f"{name}.sh"
    path.write_text(f"#!/bin/sh\necho fake {name}\nexit {exit_code}\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def write_registry(path, names):
    entries = [{"name": n, "expected": f"`{n}`", "codes": []} for n in names]
    path.write_text(json.dumps({"attacks": entries}))
    return path


def test_registry_has_all_core_attacks():
    names = [a["name"] for a in load_registry()]
    assert len(names) == len(set(names)), "ada nama ganda di registry"
    missing = [n for n in CORE_ATTACKS if n not in names]
    assert not missing, f"serangan inti hilang: {missing}"


def test_attack_list_prints_the_15_core_names():
    result = subprocess.run(
        [str(FOUNDLING), "attack", "list"], capture_output=True, text=True, cwd=ROOT
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == CORE_ATTACKS


def test_registry_expected_matches_spec_verbatim():
    spec = SPEC.read_text()
    rows = {}
    for line in spec.splitlines():
        m = re.match(r"\| `attack ([a-z-]+)` \| .* \| (.*) \|$", line)
        if m:
            rows[m.group(1)] = m.group(2)
    for attack in load_registry():
        assert attack["expected"] == rows[attack["name"]], attack["name"]


def test_registry_codes_exist_in_spec_reason_code_list():
    spec = SPEC.read_text()
    section = spec.split("### 3.7", 1)[1].split("\n### ", 1)[0]
    for attack in load_registry():
        for code in attack["codes"]:
            assert re.search(rf"`{re.escape(code)}`|`{re.escape(code)}\{{", section), (
                attack["name"],
                code,
            )


def test_dispatcher_unimplemented_exits_2(tmp_path):
    result = run("run", "over-cap", attacks_dir=tmp_path)
    assert result.returncode == 2
    assert "NOT_IMPLEMENTED: over-cap" in result.stderr


def test_dispatcher_unknown_attack_exits_2():
    result = run("run", "no-such-attack")
    assert result.returncode == 2
    assert "UNKNOWN_ATTACK: no-such-attack" in result.stderr


def test_summary_counts_pass_fail_correctly(tmp_path):
    attacks = tmp_path / "attacks"
    attacks.mkdir()
    make_script(attacks, "alpha", 0)
    make_script(attacks, "beta", 1)
    make_script(attacks, "delta", 2)
    registry = write_registry(tmp_path / "r.json", ["alpha", "beta", "gamma", "delta"])

    result = run("run-all", attacks_dir=attacks, registry=registry)

    lines = result.stdout.splitlines()
    assert any(re.fullmatch(r"alpha\s+PASS", l) for l in lines), result.stdout
    assert any(re.fullmatch(r"beta\s+FAIL", l) for l in lines), result.stdout
    assert any(re.fullmatch(r"gamma\s+NOT_IMPLEMENTED", l) for l in lines), result.stdout
    assert any(re.fullmatch(r"delta\s+ERROR", l) for l in lines), result.stdout
    assert "PASS=1 FAIL=1 NOT_IMPLEMENTED=1 ERROR=1" in result.stdout
    assert result.returncode == 1


def test_non_executable_script_is_error_not_unimplemented(tmp_path):
    (tmp_path / "over-cap.sh").write_text("#!/bin/sh\nexit 0\n")
    result = run("run", "over-cap", attacks_dir=tmp_path)
    assert result.returncode == 2
    assert "NOT_EXECUTABLE" in result.stderr
    assert "NOT_IMPLEMENTED" not in result.stderr


def test_run_normalizes_script_exit_codes_to_0_1_2(tmp_path):
    registry = write_registry(tmp_path / "r.json", ["seven"])
    make_script(tmp_path, "seven", 7)
    result = run("run", "seven", attacks_dir=tmp_path, registry=registry)
    assert result.returncode == 2


def test_signal_killed_script_is_error(tmp_path):
    registry = write_registry(tmp_path / "r.json", ["killed"])
    path = tmp_path / "killed.sh"
    path.write_text("#!/bin/sh\nkill -9 $$\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    result = run("run-all", attacks_dir=tmp_path, registry=registry)
    assert "ERROR=1" in result.stdout
    assert result.returncode == 2


def test_missing_registry_exits_2_not_1(tmp_path):
    result = run("run-all", registry=tmp_path / "nope.json")
    assert result.returncode == 2
    assert "Traceback" not in result.stderr
    assert "BAD_REGISTRY" in result.stderr


def test_empty_registry_exits_2(tmp_path):
    registry = tmp_path / "r.json"
    registry.write_text('{"attacks": []}')
    result = run("run-all", registry=registry)
    assert result.returncode == 2
    assert "BAD_REGISTRY" in result.stderr


def test_duplicate_registry_names_exit_2(tmp_path):
    registry = write_registry(tmp_path / "r.json", ["a", "a"])
    result = run("run-all", registry=registry)
    assert result.returncode == 2
    assert "BAD_REGISTRY" in result.stderr


def test_run_all_exits_0_when_nothing_fails(tmp_path):
    attacks = tmp_path / "attacks"
    attacks.mkdir()
    make_script(attacks, "alpha", 0)
    registry = write_registry(tmp_path / "r.json", ["alpha", "gamma"])
    result = run("run-all", attacks_dir=attacks, registry=registry)
    assert "PASS=1 FAIL=0 NOT_IMPLEMENTED=1 ERROR=0" in result.stdout
    assert result.returncode == 0


def test_make_attack_lab_iterates_registry():
    result = subprocess.run(
        ["make", "-s", "attack-lab"], capture_output=True, text=True, cwd=ROOT
    )
    assert result.returncode == 0, result.stderr
    for name in CORE_ATTACKS:
        assert re.search(rf"^{name}\s+NOT_IMPLEMENTED$", result.stdout, re.M), name
    assert f"NOT_IMPLEMENTED={len(CORE_ATTACKS)}" in result.stdout
