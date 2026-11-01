# Shared helpers for SP9 testnet runs (burner keys only). Source from the sp9 folder.
P=$(cat keys/PARENT)
V="vault.$P"
LOG=results.log

# fcall <label> <contract> <method> <json_args> <signer> <keyfile> [deposit]
# Prints one line: label, tx id and the on-chain outcome (or the RPC rejection).
fcall() {
  local out tx
  out=$(near contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas '30 Tgas' \
    attached-deposit "${7:-0 NEAR}" sign-as "$5" network-config testnet \
    sign-with-access-key-file "$6" send 2>&1)
  tx=$(echo "$out" | grep -o -E 'Transaction ID: [A-Za-z0-9]+' | head -1 | awk '{print $3}')
  if [ -n "$tx" ]; then
    echo "$1 | tx $tx | $(python3 tools/rpc.py tx "$tx" "$5" | grep '^status' | cut -c1-220)" | tee -a "$LOG"
  else
    # near-cli prints no tx id when the call fails; keep the error text after "Error:".
    echo "$1 | GAGAL | $(echo "$out" | sed 's/\x1b\[[0-9;]*m//g' | sed -n '/^Error:/,$p' | grep -v -E '^(Error:|Location:|\s*src/)' | tr -s ' \n' ' ' | cut -c1-300)" | tee -a "$LOG"
  fi
}
