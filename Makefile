CONTRACTS := vault mock-oracle mock-ref mock-outlayer mock-token

.PHONY: quick wasm sandbox

# Unit tests and proptest of every contract. No sandbox, no wasm build.
quick:
	@for c in $(CONTRACTS); do \
		echo "== $$c"; \
		(cd contracts/$$c && cargo test) || exit 1; \
	done

# The sandbox deploys these builds, so they are rebuilt first. stdin is closed because
# cargo-near can hang waiting on it when there is no terminal.
wasm:
	@for c in $(CONTRACTS); do \
		echo "== build $$c"; \
		(cd contracts/$$c && cargo near build non-reproducible-wasm < /dev/null) || exit 1; \
	done

# near-workspaces tests against a local sandbox node. The first run downloads neard.
sandbox: wasm
	cd sandbox && cargo test
