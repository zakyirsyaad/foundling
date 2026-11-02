//! The lines a verifier reads. A check either holds, fails, or could not run yet.

#[derive(Debug, Default)]
pub struct Report {
    pub lines: Vec<String>,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
}

impl Report {
    pub fn check(&mut self, name: &str, holds: bool, detail: &str) -> bool {
        if holds {
            self.passed += 1;
            self.lines.push(format!("PASS {name}"));
        } else {
            self.failed += 1;
            self.lines.push(format!("FAIL {name}: {detail}"));
        }
        holds
    }

    pub fn skip(&mut self, name: &str, reason: &str) {
        self.skipped += 1;
        self.lines.push(format!("SKIP {name}: {reason}"));
    }

    pub fn summary(&self) -> String {
        format!(
            "SUMMARY pass={} skip={} fail={}",
            self.passed, self.skipped, self.failed
        )
    }
}
