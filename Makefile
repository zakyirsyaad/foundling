CONTRACTS := vault mock-oracle mock-ref mock-outlayer mock-token

.PHONY: quick wasm sandbox attack-lab

# Unit tests and proptest of every contract and the strategy, as CI runs them: --locked,
# so a stale Cargo.lock fails here and is not rewritten. No sandbox, no wasm build.
quick:
	@for c in $(CONTRACTS); do \
		echo "== $$c"; \
		(cd contracts/$$c && cargo test --locked) || exit 1; \
	done
	@echo "== strategy"
	@cd strategy && cargo test --locked && cargo test --locked --features rehearsal

# The sandbox deploys these builds, so they are rebuilt first. --no-embed-abi matches the
# vault build CI audits, so the sandbox tests the same binary. stdin is closed because
# cargo-near can hang waiting on it when there is no terminal.
wasm:
	@for c in $(CONTRACTS); do \
		echo "== build $$c"; \
		(cd contracts/$$c && cargo near build non-reproducible-wasm --no-embed-abi < /dev/null) || exit 1; \
	done

# near-workspaces tests against a local sandbox node. The first run downloads neard.
sandbox: wasm
	cd sandbox && cargo test --locked

# Runs every core attack in tools/attack-registry.json and prints PASS/FAIL/NOT_IMPLEMENTED/ERROR.
attack-lab:
	@python3 tools/attack.py run-all
