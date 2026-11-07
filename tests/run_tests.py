#!/usr/bin/env python3
"""Run @lam/vulture/dev-plugin tests in an isolated extlibs tree."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_VULTURE_ROOT = ROOT.parent / "lam-vulture"
COMPILER = "lamc"
MIN_COMPILER_VERSION = (4, 0, 0)
VERSION_PATTERN = re.compile(r"(?:lamc\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?")
IGNORES = shutil.ignore_patterns(
    ".git",
    "build",
    "extlibs",
    "*.lamc-cache",
    "__pycache__",
    "*.pyc",
)
def run_command(
    command: list[str], *, cwd: Path, timeout: int
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def require_compiler() -> bool:
    try:
        result = run_command([COMPILER, "version"], cwd=ROOT, timeout=15)
    except FileNotFoundError:
        print(f"error: {COMPILER} is not installed or is not on PATH", file=sys.stderr)
        return False
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"error: unable to execute '{COMPILER} version': {exc}", file=sys.stderr)
        return False

    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or str(result.returncode)
        print(f"error: unable to check {COMPILER} version: {detail}", file=sys.stderr)
        return False
    version_text = result.stdout.strip()
    match = VERSION_PATTERN.fullmatch(version_text)
    if match is None:
        print(f"error: unrecognized {COMPILER} version: {version_text!r}", file=sys.stderr)
        return False
    version = tuple(int(part) for part in match.groups())
    if not (MIN_COMPILER_VERSION <= version < (5, 0, 0)):
        print(
            f"error: tests require lamc >=4.0, <5; found {version_text}",
            file=sys.stderr,
        )
        return False
    return True


def validate_checkout(path: Path, label: str) -> bool:
    missing = [name for name in ("lamlib.toml", "__init__.lam") if not (path / name).is_file()]
    if not path.is_dir() or missing:
        suffix = f" (missing {', '.join(missing)})" if missing else ""
        print(f"error: {label} checkout is not ready at {path}{suffix}", file=sys.stderr)
        return False
    return True


def expectations(source: str) -> list[str]:
    expected: list[str] = []
    for line in source.splitlines():
        match = re.match(r"^\s*#\s*expect:\s?(.*)$", line)
        if match is not None:
            expected.append(match.group(1).rstrip())
    return expected


def stage_packages(extlibs: Path, vulture_root: Path) -> None:
    """Stage @lam/vulture, then this package at its canonical path."""
    vulture_destination = extlibs / "@lam" / "vulture"
    vulture_destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(vulture_root, vulture_destination, ignore=IGNORES)
    plugin_destination = vulture_destination / "dev-plugin"
    if plugin_destination.exists():
        raise RuntimeError(f"staged plugin destination already exists: {plugin_destination}")
    shutil.copytree(ROOT, plugin_destination, ignore=IGNORES)


def failure_details(label: str, result: subprocess.CompletedProcess[str]) -> str:
    lines = [f"{label} (exit {result.returncode})"]
    if result.stdout.strip():
        lines.append("stdout:\n" + result.stdout.rstrip())
    if result.stderr.strip():
        lines.append("stderr:\n" + result.stderr.rstrip())
    return "\n".join(lines)


def run_case(
    case: Path, extlibs: Path, output_root: Path
) -> tuple[bool, str]:
    source = case.read_text(encoding="utf-8")
    expected = expectations(source)
    if not expected:
        return False, "TEST ERROR: no '# expect:' directives found"

    relative_parts = case.relative_to(ROOT / "tests").parts
    binary = output_root / ("__".join(relative_parts) + ".bin")
    command = [
        COMPILER,
        "build",
        str(case),
        "--extlibs",
        str(extlibs),
        "--no-cache",
        "-o",
        str(binary),
    ]
    try:
        compiled = run_command(command, cwd=output_root, timeout=300)
    except subprocess.TimeoutExpired:
        return False, "COMPILE FAIL: timed out after 300 seconds"
    except OSError as exc:
        return False, f"COMPILE FAIL: {exc}"
    if compiled.returncode != 0:
        return False, failure_details("COMPILE FAIL", compiled)

    try:
        executed = run_command([str(binary)], cwd=output_root, timeout=90)
    except subprocess.TimeoutExpired:
        return False, "RUN FAIL: timed out after 90 seconds"
    except OSError as exc:
        return False, f"RUN FAIL: {exc}"
    if executed.returncode != 0:
        return False, failure_details("RUN FAIL", executed)

    actual = executed.stdout.rstrip("\n")
    expected_text = "\n".join(expected)
    if actual != expected_text:
        detail = (
            "OUTPUT MISMATCH:\n"
            f"  expected: {expected_text!r}\n"
            f"  actual:   {actual!r}"
        )
        if executed.stderr:
            detail += f"\n  stderr:   {executed.stderr.rstrip()!r}"
        return False, detail
    return True, "ok"


def main() -> int:
    parser = argparse.ArgumentParser(description="@lam/vulture/dev-plugin test runner")
    parser.add_argument("--verbose", "-v", action="store_true", help="show full failures")
    parser.add_argument("--filter", "-f", help="run cases whose path contains this text")
    parser.add_argument(
        "--vulture",
        type=Path,
        default=DEFAULT_VULTURE_ROOT,
        help=f"@lam/vulture checkout (default: {DEFAULT_VULTURE_ROOT})",
    )
    args = parser.parse_args()

    if not require_compiler():
        return 1
    vulture_root = args.vulture.expanduser().resolve()
    if not validate_checkout(vulture_root, "sibling @lam/vulture"):
        return 1

    cases = sorted(path for path in (ROOT / "tests").rglob("test_*.lam") if path.is_file())
    if args.filter:
        needle = args.filter.lower()
        cases = [case for case in cases if needle in str(case.relative_to(ROOT)).lower()]
    if not cases:
        print("error: no matching Lam test cases found", file=sys.stderr)
        return 2

    failures: list[tuple[Path, str]] = []
    with tempfile.TemporaryDirectory(prefix="lam-vulture-dev-plugin-tests-") as temporary:
        temporary_root = Path(temporary)
        extlibs = temporary_root / "extlibs"
        outputs = temporary_root / "outputs"
        outputs.mkdir()
        try:
            stage_packages(extlibs, vulture_root)
        except (OSError, RuntimeError) as exc:
            print(f"error: unable to stage packages: {exc}", file=sys.stderr)
            return 1

        print(f"Running {len(cases)} @lam/vulture/dev-plugin test(s)...\n")
        for case in cases:
            relative = case.relative_to(ROOT)
            ok, message = run_case(case, extlibs, outputs)
            print(f"  {'PASS' if ok else 'FAIL'}  {relative}")
            if not ok:
                failures.append((relative, message))
                if args.verbose:
                    for line in message.splitlines():
                        print(f"        {line}")

    passed = len(cases) - len(failures)
    print(f"\nResults: {passed} passed, {len(failures)} failed, {len(cases)} total")
    if failures and not args.verbose:
        print("Re-run with --verbose for failure details.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
