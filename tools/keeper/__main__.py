"""Command line: `python3 -m tools.keeper run` and `python3 -m tools.keeper summary LOG`."""

import argparse
import json
import os
import sys
import time
from urllib.parse import urlparse

from .bot import Bot, Config, ConfigError
from .logstore import FileStore, JsonlLog, StateError
from .near_cli import NearCli, NearCliError, run_subprocess
from .rpc import RpcClient, RpcError
from .soak import render, summarize_log

TESTNET_RPCS = ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"]


class TeeLog:
    """Every log line also goes to the console. Records carry no key material by construction."""

    def __init__(self, log, stream):
        self.log, self.stream = log, stream

    def write(self, record):
        self.log.write(record)
        print(json.dumps(record, separators=(",", ":")), file=self.stream, flush=True)


def build_parser():
    parser = argparse.ArgumentParser(prog="python3 -m tools.keeper")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="run the keeper until stopped")
    run.add_argument("--vault")
    run.add_argument("--keeper-account")
    run.add_argument("--key-file", help="path handed to near-cli; the bot never opens it")
    run.add_argument("--network")
    run.add_argument("--rpc-urls", help="comma separated, at least two")
    run.add_argument("--log")
    run.add_argument("--state")
    run.add_argument("--allow-mainnet", action="store_true")
    run.add_argument("--poll-interval", type=float)
    run.add_argument("--gas-trigger", type=int)
    run.add_argument("--gas-execute", type=int)
    run.add_argument("--gas-advance", type=int)
    run.add_argument("--retry-interval", type=int)
    summary = commands.add_parser("summary", help="judge a soak log")
    summary.add_argument("log")
    summary.add_argument("--min-cycles", type=int, default=1)
    return parser


def resolve(args, environ):
    def pick(value, name, default=None):
        return value if value is not None else environ.get(name, default)

    vault = pick(args.vault, "FOUNDLING_VAULT")
    account = pick(args.keeper_account, "FOUNDLING_KEEPER_ACCOUNT")
    if not vault:
        raise ConfigError("set FOUNDLING_VAULT or --vault")
    if not account:
        raise ConfigError("set FOUNDLING_KEEPER_ACCOUNT or --keeper-account")
    network = pick(args.network, "FOUNDLING_NETWORK", "testnet")
    raw = pick(args.rpc_urls, "FOUNDLING_RPC_URLS")
    urls = [u.strip() for u in raw.split(",") if u.strip()] if raw else (
        TESTNET_RPCS if network == "testnet" else [])
    if len(set(urls)) < 2:
        raise ConfigError("at least two RPC endpoints are needed: set FOUNDLING_RPC_URLS")
    overrides = {name: getattr(args, name) for name in
                 ("poll_interval", "gas_trigger", "gas_execute", "gas_advance", "retry_interval")
                 if getattr(args, name) is not None}
    config = Config(vault=vault, keeper_account=account, network=network,
                    allow_mainnet=args.allow_mainnet, **overrides)
    return config, urls


def parse_config(argv, environ):
    return resolve(build_parser().parse_args(argv), environ)


def main(argv=None, environ=None, stderr=None, *, rpc=None, runner=None, sleep=None, clock=None,
         stop=None):
    environ = os.environ if environ is None else environ
    stderr = stderr or sys.stderr
    sleep = sleep or time.sleep
    clock = clock or time.time
    args = build_parser().parse_args(argv)
    if args.command == "summary":
        try:
            with open(args.log, encoding="utf-8") as handle:
                summary = summarize_log(handle, min_cycles=args.min_cycles)
        except OSError as exc:
            print(f"error: cannot read {args.log}: {exc.strerror}", file=stderr)
            return 2
        print(render(summary))
        return 0 if summary.passed else 1

    try:
        config, urls = resolve(args, environ)
        key_file = environ.get("FOUNDLING_KEEPER_KEY_FILE") if args.key_file is None else args.key_file
        if not key_file:
            raise ConfigError("set FOUNDLING_KEEPER_KEY_FILE or --key-file")
        if not os.path.isfile(key_file):
            raise ConfigError("the file named by FOUNDLING_KEEPER_KEY_FILE does not exist")
        log_path = args.log or environ.get("FOUNDLING_KEEPER_LOG", "keeper-soak.jsonl")
        state_path = args.state or environ.get("FOUNDLING_KEEPER_STATE", log_path + ".state.json")
        bot = Bot(
            config,
            rpc=rpc or RpcClient(urls, sleep=sleep),
            near=NearCli(config.keeper_account, key_file, config.network, runner=runner or run_subprocess),
            sleep=sleep, clock=clock, log=TeeLog(JsonlLog(log_path), stderr), store=FileStore(state_path),
        )
        bot.preflight()
    except (ConfigError, StateError) as exc:
        print(f"error: {exc}", file=stderr)
        return 2
    except RpcError as exc:
        print(f"error: preflight failed: {exc}", file=stderr)
        return 1

    hosts = ", ".join(urlparse(u).hostname or "?" for u in urls)
    print(f"keeper: vault={config.vault} account={config.keeper_account} network={config.network} "
          f"rpc={hosts} log={log_path}", file=stderr, flush=True)
    try:
        bot.run(stop or (lambda: False))
    except KeyboardInterrupt:
        return 130
    except NearCliError as exc:
        print(f"error: {exc}", file=stderr)
        return 2
    except RpcError as exc:
        print(f"error: {exc}", file=stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
