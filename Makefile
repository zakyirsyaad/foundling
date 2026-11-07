CONTRACTS := vault mock-oracle mock-ref mock-outlayer mock-token
MOCKS := mock-oracle mock-ref mock-outlayer mock-token

.PHONY: quick wasm sandbox attack-lab attack-warm attack-lab-full attack-proofs verify verify-strict

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
		(cd contracts/$$c && cargo near build non-reproducible-wasm --no-embed-abi < /dev/null && touch target/near/*.wasm) || exit 1; \
	done

# near-workspaces tests against a local sandbox node. The first run downloads neard.
sandbox: wasm
	cd sandbox && cargo test --locked

# Runs every core attack in tools/attack-registry.json and prints PASS/FAIL/NOT_IMPLEMENTED/ERROR.
# It builds nothing, so it runs where only Python exists (the CI scaffold job). A sandbox attack
# whose wasm is missing exits 2 at once and says to run `make wasm`.
attack-lab:
	@python3 tools/attack.py run-all

# The same, with the wasm and the sandbox tests built first, and one sandbox test run so the neard
# binary is downloaded now. Builds or a download inside an attack would count against its 300 s
# limit and report ERROR for what is only a cold cache.
attack-lab-full: wasm
	@$(MAKE) --no-print-directory attack-warm
	@python3 tools/attack.py run-all

# Compiles the sandbox attack tests and runs one sandbox test so neard is downloaded. It needs the
# wasm built first (attack-lab-full and attack-proofs build it, CI's Attack Lab run calls this after `make wasm`), so a cold cache costs the job and not the first attack's 300 s.
attack-warm:
	cd sandbox && cargo test --locked --test attacks_batch1 --no-run
	cd sandbox && cargo test --locked --test attacks_batch2 --no-run
	cd sandbox && cargo test --locked --test attacks_batch3 --no-run
	cd sandbox && cargo test --locked --test setup_policy setup_policy_overrides_reach_the_vault_and_leave_the_rest_alone -- --exact

# Regenerates the committed proofs/attack/reproducible/*.json (the evidence files claims.json points at) from a
# run on the vault built reproducibly in the pinned image, like CI's "Vault reproducible" job. It
# needs Docker and a committed checkout, and the audited vault is the only reproducible build: the
# mocks are built the usual way. A plain `make attack-lab` writes to the ignored proofs/attack/local.
attack-proofs:
	cd contracts/vault && cargo near build reproducible-wasm < /dev/null && touch target/near/*.wasm
	@for c in $(MOCKS); do \
		echo "== build $$c"; \
		(cd contracts/$$c && cargo near build non-reproducible-wasm --no-embed-abi < /dev/null && touch target/near/*.wasm) || exit 1; \
	done
	@$(MAKE) --no-print-directory attack-warm
	@FOUNDLING_PROOF_DIR=$(CURDIR)/proofs/attack/reproducible python3 tools/attack.py run-all

# The offline verifier over the committed fixtures: standard library only, no network.
verify:
	python3 verify.py

# The same, but a SKIP also fails. For CI: a fixture that stops opening its commitment must not pass quietly.
verify-strict:
	python3 verify.py --strict
