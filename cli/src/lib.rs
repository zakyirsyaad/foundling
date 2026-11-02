//! Offline checks of a Foundling proof file, for `verify.py` and anyone who wants to repeat
//! them. The quote signature and the replay need Rust; everything else lives in `verify.py`.

pub mod attestation;
pub mod hex;
pub mod proof;
pub mod replay;
pub mod report;

use proof::Proof;
use report::Report;

pub fn check(proof: &Proof) -> Report {
    let mut report = Report::default();
    report.check("proof has cycles", !proof.cycles.is_empty(), "no cycles");
    let params = replay::open_params(proof, &mut report);
    let mut reproduced = 0;
    for cycle in &proof.cycles {
        reproduced += usize::from(replay::check_cycle(
            proof,
            cycle,
            params.as_ref(),
            &mut report,
        ));
        attestation::check_cycle(proof, cycle, &mut report);
    }
    if params.is_some() {
        report
            .lines
            .push(format!("{reproduced}/{} reproduced", proof.cycles.len()));
    }
    report
}
