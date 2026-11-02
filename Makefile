.PHONY: attack-lab

# Runs every core attack in tools/attack-registry.json and prints PASS/FAIL/NOT_IMPLEMENTED/ERROR.
attack-lab:
	@python3 tools/attack.py run-all
