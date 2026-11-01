//! A labelled stand-in for `aggregate-oracle.near`, which does not exist on testnet. It
//! answers in the same shape, so the vault code under test is the code that ships.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

const NANOS_PER_SECOND: u64 = 1_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Feed {
    pub price: U128,
    pub conf: U128,
    pub expo: i32,
    /// How old each answer looks, so a stale feed can be staged.
    pub lag_seconds: u64,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct Price {
    pub price: U128,
    pub conf: U128,
    pub expo: i32,
    pub publish_time: u64,
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Feeds,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOracle {
    owner: AccountId,
    feeds: LookupMap<String, Feed>,
}

#[near]
impl MockOracle {
    #[init]
    pub fn init(owner: AccountId) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "init: only the oracle account"
        );
        Self {
            owner,
            feeds: LookupMap::new(StorageKey::Feeds),
        }
    }

    pub fn set_feed(&mut self, price_id: String, feed: Feed) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner"
        );
        self.feeds.insert(price_id, feed);
    }

    pub fn list_prices_no_older_than(
        &self,
        price_ids: Vec<String>,
        age: u64,
    ) -> BTreeMap<String, Option<Price>> {
        let now = env::block_timestamp() / NANOS_PER_SECOND;
        price_ids
            .into_iter()
            .map(|id| {
                let price = self
                    .feeds
                    .get(&id)
                    .filter(|feed| feed.lag_seconds <= age)
                    .map(|feed| Price {
                        price: feed.price,
                        conf: feed.conf,
                        expo: feed.expo,
                        publish_time: now.saturating_sub(feed.lag_seconds),
                    });
                (id, price)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::serde_json::{self, json};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    use super::*;

    const NOW: u64 = 1_800_000_000;

    fn call_from(account: &str) {
        let account: AccountId = account.parse().unwrap();
        let mut context = VMContextBuilder::new();
        context
            .current_account_id("oracle.testnet".parse().unwrap())
            .predecessor_account_id(account)
            .block_timestamp(NOW * NANOS_PER_SECOND);
        testing_env!(context.build());
    }

    fn oracle_with_lag(lag_seconds: u64) -> MockOracle {
        call_from("oracle.testnet");
        let mut oracle = MockOracle::init("owner.testnet".parse().unwrap());
        call_from("owner.testnet");
        oracle.set_feed(
            "near".to_string(),
            Feed {
                price: U128(437_673_488),
                conf: U128(171_059),
                expo: -8,
                lag_seconds,
            },
        );
        oracle
    }

    fn ids() -> Vec<String> {
        vec!["near".to_string()]
    }

    #[test]
    fn a_fresh_feed_answers_in_the_mainnet_shape() {
        let oracle = oracle_with_lag(30);

        let answer = serde_json::to_value(oracle.list_prices_no_older_than(ids(), 120)).unwrap();

        let expected = json!({"near": {
            "price": "437673488", "conf": "171059", "expo": -8, "publish_time": NOW - 30,
        }});
        assert_eq!(answer, expected);
    }

    #[test]
    fn a_feed_at_the_age_limit_still_answers() {
        let oracle = oracle_with_lag(120);

        let answer = oracle.list_prices_no_older_than(ids(), 120);

        assert!(answer["near"].is_some());
    }

    #[test]
    fn a_feed_older_than_the_age_is_null() {
        let oracle = oracle_with_lag(121);

        let answer = serde_json::to_value(oracle.list_prices_no_older_than(ids(), 120)).unwrap();

        assert_eq!(answer, json!({"near": null}));
    }

    #[test]
    fn an_unknown_feed_is_null() {
        let oracle = oracle_with_lag(0);

        let answer = oracle.list_prices_no_older_than(vec!["usdc".to_string()], 120);

        assert_eq!(answer["usdc"], None);
    }

    #[test]
    #[should_panic(expected = "init: only the oracle account")]
    fn a_stranger_cannot_initialise_the_oracle() {
        call_from("stranger.testnet");

        MockOracle::init("stranger.testnet".parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn only_the_owner_sets_a_feed() {
        let mut oracle = oracle_with_lag(0);
        call_from("stranger.testnet");

        oracle.set_feed(
            "near".to_string(),
            Feed {
                price: U128(1),
                conf: U128(0),
                expo: -8,
                lag_seconds: 0,
            },
        );
    }
}
