"""floor-claude (DESIGN 9.3 seam S4, C7.3): the Scheduled floor's subscription guard.

Agency Web's guard.py (101 lines, /nix/store/gb8z6rv3nb5vn019pw3jbk2rzv1n46hf-guard.py)
with two changes, both from ruling R5 (the master agency is ~): its refusal of
cwd == HOME (guard.py:60-62) is gone, and when cwd is HOME the guard also checks
~/.claude/settings.local.json, the project-local settings Claude reads there.
Everything else is unchanged.

One subscription-only executable seam for chat, catalog and helper calls.

Never read credential files. Ask Claude's own auth command, keep its response
in memory, and print only a fixed classification/error. User/project settings,
skills, hooks and native persistence remain Claude's responsibility.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SENSITIVE = re.compile(r"KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION|COOKIE|CREDENTIAL|PRIVATE|NETRC", re.I)


def scrub(env):
    return {
        key: value for key, value in env.items()
        if not SENSITIVE.search(key)
        and not key.upper().startswith(("ANTHROPIC_", "DSH_", "CLAUDE_CODE_USE_"))
        and key not in {"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CONFIG_PATH"}
    }


def settings_files(env, cwd):
    seat = Path(env.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    yield seat / "settings.json"
    if cwd == Path.home():
        # R5: ~ is the master agency; Claude reads its project-local settings.
        yield Path.home() / ".claude" / "settings.local.json"
    for root in [cwd, *cwd.parents]:
        if root == Path.home():
            break
        yield root / ".claude" / "settings.json"
        yield root / ".claude" / "settings.local.json"
        if (root / ".git").exists():
            break
    yield Path("/etc/claude-code/managed-settings.json")


def check_settings(document):
    # Auth status alone does not prove that a later noninteractive turn will
    # ignore an apiKeyHelper or a settings-level provider environment override.
    if not isinstance(document, dict):
        raise ValueError("invalid settings")
    if document.get("apiKeyHelper") or document.get("forceLoginMethod") == "console":
        raise ValueError("API authentication configured in settings")
    overrides = document.get("env", {})
    if not isinstance(overrides, dict):
        raise ValueError("invalid settings environment")
    for key, value in overrides.items():
        if value and (SENSITIVE.search(key) or key.upper().startswith(("ANTHROPIC_", "CLAUDE_CODE_USE_"))):
            raise ValueError("provider or credential override configured in settings")


def main():
    binary, *args = sys.argv[1:]
    env = scrub(os.environ)
    # The CLI executable is pinned by Nix. No SDK binary fallback, cloud
    # provider selection or caller-supplied API key can enter this seam.
    env["CLAUDE_CODE_ENTRYPOINT"] = "sdk-ts"
    cwd = Path.cwd()
    if "--bare" in args:
        raise ValueError("bare mode cannot use a subscription login")
    for path in settings_files(env, cwd):
        if path.is_file():
            check_settings(json.loads(path.read_text()))
    # SDK inline settings are normally teammateMode/ultracode. Qualify these
    # too, without logging arguments or potentially sensitive document values.
    auth_args = []
    for index, arg in enumerate(args):
        if arg == "--settings" and index + 1 < len(args):
            value = args[index + 1]
        elif arg.startswith("--settings="):
            value = arg.split("=", 1)[1]
        else:
            continue
        source = value if value.lstrip().startswith("{") else Path(value).read_text()
        check_settings(json.loads(source))
        auth_args += ["--settings", value]
    if args not in (["--version"], ["-v"], ["--help"], ["-h"], ["auth", "status", "--json"]):
        status = subprocess.run(
            [binary, *auth_args, "auth", "status", "--json"], env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=20, check=False,
        )
        report = json.loads(status.stdout)
        if (status.returncode != 0 or report.get("loggedIn") is not True
                or report.get("authMethod") != "claude.ai"
                or report.get("apiProvider") != "firstParty"):
            raise ValueError("the selected seat needs a first-party Claude subscription login")
    os.execve(binary, [binary, *args], env)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError):
        # Do not print arbitrary settings, paths, CLI stderr or auth responses.
        print("floor-claude: subscription preflight failed; use a logged-in cc/cc2 seat without API/provider overrides", file=sys.stderr)
        sys.exit(2)
