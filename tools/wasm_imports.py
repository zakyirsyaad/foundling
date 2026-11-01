"""List a WASM module's host imports and audit them against an allowlist.

Usage: python3 tools/wasm_imports.py <file.wasm> [allowlist.txt]
Exit 1 if any import is account-mutating or (with an allowlist) not allowlisted.
"""

import re
import sys

# Host functions that change accounts or keys; a sealed vault must import none of them.
ACCOUNT_MUTATING = re.compile(
    r"promise_batch_action_(create_account|deploy_contract|deploy_global_contract\w*|use_global_contract\w*"
    r"|add_key\w*|delete_key|delete_account|stake|state_init\w*|\w*gas_key\w*)"
)


def leb128(buf, pos):
    result = shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, pos


def name(buf, pos):
    size, pos = leb128(buf, pos)
    return buf[pos:pos + size].decode(), pos + size


def skip_limits(buf, pos):
    flags = buf[pos]
    _, pos = leb128(buf, pos + 1)
    if flags & 1:
        _, pos = leb128(buf, pos)
    return pos


def imports(buf):
    if buf[:4] != b"\0asm":
        raise ValueError("not a wasm module")
    pos = 8
    while pos < len(buf):
        section_id = buf[pos]
        size, pos = leb128(buf, pos + 1)
        end = pos + size
        if section_id == 2:
            count, p = leb128(buf, pos)
            for _ in range(count):
                module, p = name(buf, p)
                field, p = name(buf, p)
                kind = buf[p]
                p += 1
                if kind == 0:
                    _, p = leb128(buf, p)
                elif kind == 1:
                    p = skip_limits(buf, p + 1)
                elif kind == 2:
                    p = skip_limits(buf, p)
                elif kind == 3:
                    p += 2
                yield module, field, kind
        pos = end


def main():
    wasm = open(sys.argv[1], "rb").read()
    allow = None
    if len(sys.argv) > 2:
        allow = {line.strip() for line in open(sys.argv[2]) if line.strip() and not line.startswith("#")}
    failed = False
    found = list(imports(wasm))
    for module, field, kind in found:
        flag = ""
        if ACCOUNT_MUTATING.fullmatch(field):
            flag, failed = "  << PENGUBAH AKUN", True
        elif allow is not None and field not in allow:
            flag, failed = "  << TIDAK DI ALLOWLIST", True
        print(f"{module}.{field}{flag}")
    print(f"total {len(found)} impor, {'GAGAL' if failed else 'LULUS'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
