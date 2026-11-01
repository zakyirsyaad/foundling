use crate::limits::{check_buy, check_sell, BuyContext, Reject, SellContext, Window};
use crate::tests::policy::demo_policy;

const USDC: u128 = 1_000_000;
const WNEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn buy(amount_in: u128) -> BuyContext {
    BuyContext {
        amount_in,
        nav_usdc: 100 * USDC,
        usdc_book: 100 * USDC,
        wnear_value_usdc: 0,
        window_used: 0,
    }
}

fn sell(amount_in: u128) -> SellContext {
    SellContext {
        amount_in,
        wnear_book: 10 * WNEAR,
        window_used: 0,
    }
}

#[test]
fn a_buy_inside_every_limit_passes() {
    assert_eq!(check_buy(&demo_policy(), &buy(10 * USDC)), Ok(()));
}

#[test]
fn the_bps_cap_is_checked_first() {
    assert_eq!(
        check_buy(&demo_policy(), &buy(10 * USDC + 1)),
        Err(Reject::OverCap)
    );
}

#[test]
fn an_inflated_nav_still_hits_the_absolute_cap() {
    let context = BuyContext {
        nav_usdc: 1_000_000 * USDC,
        usdc_book: 1_000_000 * USDC,
        ..buy(15 * USDC + 1)
    };

    assert_eq!(check_buy(&demo_policy(), &context), Err(Reject::OverAbsCap));
}

#[test]
fn the_window_stops_a_drip_of_small_buys() {
    let context = BuyContext {
        window_used: 11 * USDC,
        ..buy(10 * USDC)
    };

    assert_eq!(
        check_buy(&demo_policy(), &context),
        Err(Reject::OverEpochCap)
    );
}

#[test]
fn a_buy_cannot_exceed_the_book() {
    let context = BuyContext {
        usdc_book: 5 * USDC,
        ..buy(6 * USDC)
    };

    assert_eq!(check_buy(&demo_policy(), &context), Err(Reject::OverBook));
}

#[test]
fn a_buy_cannot_push_exposure_over_the_limit() {
    let context = BuyContext {
        wnear_value_usdc: 45 * USDC,
        usdc_book: 55 * USDC,
        ..buy(5 * USDC + 1)
    };

    assert_eq!(
        check_buy(&demo_policy(), &context),
        Err(Reject::ExposureLimit)
    );
}

#[test]
fn a_buy_exactly_at_the_exposure_limit_passes() {
    let context = BuyContext {
        wnear_value_usdc: 45 * USDC,
        usdc_book: 55 * USDC,
        ..buy(5 * USDC)
    };

    assert_eq!(check_buy(&demo_policy(), &context), Ok(()));
}

#[test]
fn exposure_is_checked_before_the_book() {
    let context = BuyContext {
        wnear_value_usdc: 49 * USDC,
        usdc_book: 5 * USDC,
        ..buy(6 * USDC)
    };

    assert_eq!(
        check_buy(&demo_policy(), &context),
        Err(Reject::ExposureLimit)
    );
}

#[test]
fn a_sell_inside_every_limit_passes() {
    assert_eq!(check_sell(&demo_policy(), &sell(4 * WNEAR)), Ok(()));
}

#[test]
fn a_sell_cannot_pass_the_absolute_cap() {
    assert_eq!(
        check_sell(&demo_policy(), &sell(4 * WNEAR + 1)),
        Err(Reject::OverAbsCap)
    );
}

#[test]
fn a_sell_cannot_pass_half_of_the_wnear_book() {
    let context = SellContext {
        wnear_book: 6 * WNEAR,
        ..sell(3 * WNEAR + 1)
    };

    assert_eq!(
        check_sell(&demo_policy(), &context),
        Err(Reject::OverAbsCap)
    );
}

#[test]
fn a_small_book_can_be_swept_in_full() {
    let context = SellContext {
        wnear_book: 3 * WNEAR,
        ..sell(3 * WNEAR)
    };

    assert_eq!(check_sell(&demo_policy(), &context), Ok(()));
}

#[test]
fn a_sell_cannot_exceed_the_book() {
    let context = SellContext {
        wnear_book: 3 * WNEAR,
        ..sell(3 * WNEAR + 1)
    };

    assert_eq!(check_sell(&demo_policy(), &context), Err(Reject::OverBook));
}

#[test]
fn the_window_stops_a_drip_of_small_sells() {
    let context = SellContext {
        window_used: 5 * WNEAR,
        ..sell(3 * WNEAR + 1)
    };

    assert_eq!(
        check_sell(&demo_policy(), &context),
        Err(Reject::OverEpochCap)
    );
}

#[test]
fn the_window_counts_only_the_last_epoch() {
    let window = Window::default().recorded(100, 5).recorded(200, 7);

    assert_eq!(window.used(300, 150), 7);
}

#[test]
fn the_window_is_half_open_at_its_start() {
    let window = Window::default().recorded(100, 5);

    assert_eq!(window.used(200, 100), 0);
    assert_eq!(window.used(199, 100), 5);
}

#[test]
fn recording_drops_entries_past_the_limit_of_the_window() {
    let window = Window::default()
        .recorded(100, 1)
        .recorded(200, 2)
        .pruned(250, 100);

    assert_eq!(window.len(), 1);
    assert_eq!(window.used(250, 100), 2);
}

#[test]
fn recording_returns_a_copy() {
    let window = Window::default();

    let recorded = window.recorded(100, 5);

    assert_eq!(window.len(), 0);
    assert_eq!(recorded.len(), 1);
}
