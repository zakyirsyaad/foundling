use serde_json::json;
use sha2::{Digest, Sha256};

use super::advisor::{observe, read_advice, read_titles, MAX_TITLES, MAX_TITLE_CHARS, MODELS};
use super::sources::Call;
use super::*;

// The shape of real feeds, with invented headlines.
const PLAIN_FEED: &str = "<?xml version=\"1.0\"?><rss><channel><title>The Feed</title>\n<item>\n  <title>First headline</title>\n  <link>x</link></item>\n<item><title>Second headline</title></item></channel></rss>";
const CDATA_FEED: &str = "<rss><channel><title><![CDATA[The Feed]]></title><item><title><![CDATA[Bridge drained on chain X]]></title></item></channel></rss>";
const KEY: &str = "test-key";
const PROMPT: &str = "Classify the headlines.";
const CHAT_ID: &str = "chatcmpl-0123456789abcdef";
const FEED_HOST: &str = "www.theblock.co";
const BACKUP_FEED_HOST: &str = "cointelegraph.com";
const CHAT_HOST: &str = "cloud-api.near.ai";

fn reply_with(id: &str, content: &str, finish_reason: &str) -> Vec<u8> {
    json!({"id": id, "model": MODELS[0], "choices": [{"index": 0, "finish_reason": finish_reason,
        "message": {"role": "assistant", "content": content}}]})
    .to_string()
    .into_bytes()
}

fn chat_reply(content: &str) -> Vec<u8> {
    reply_with(CHAT_ID, content, "stop")
}

fn answer_of(content: &str) -> Option<(u8, u8)> {
    read_advice(&chat_reply(content)).map(|advice| (advice.ai_flag, advice.ai_conf))
}

fn secret(ai_key: Option<&str>) -> Secret {
    Secret {
        chain: "testnet".into(),
        wasm_hash: "bb".into(),
        salt: String::new(),
        params: Params {
            risk_on_above: 420_000_000,
            risk_off_below: 400_000_000,
            source_dev_bps: 100,
            buy_usdc: 1_000,
            sell_wnear: 2_000,
            prompt: PROMPT.into(),
        },
        ai_key: ai_key.map(Into::into),
        #[cfg(feature = "rehearsal")]
        rehearsal_obs: None,
    }
}

fn market_reply(call: &Call) -> Option<Vec<u8>> {
    let body = call.body.as_deref()?;
    Some(if body.contains("\"block\"") {
        json!({"result": {"header": {"height": 7, "timestamp": 1_800_000_000_000_000_000_u64}}})
    } else {
        let pool = json!({
            "pool_kind": "SIMPLE_POOL",
            "token_account_ids": ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "wrap.near"],
            "amounts": ["39000000", "10000000000000000000000000"],
        });
        json!({"result": {"result": pool.to_string().as_bytes(), "block_height": 7}})
    }
    .to_string()
    .into_bytes())
}

/// A healthy world, except for the hosts or models that `broken` names.
fn world(broken: &'static [&'static str]) -> impl FnMut(&Call) -> Option<Vec<u8>> {
    move |call| {
        let names = |name: &str| broken.contains(&name);
        match call.host {
            "api.kraken.com" if names("trades") => None,
            "api.kraken.com" => Some(
                br#"{"error":[],"result":{"NEARUSD":[["3.9","100.0",1800000000.0,"b","l","",1]]}}"#
                    .to_vec(),
            ),
            FEED_HOST | BACKUP_FEED_HOST if names(call.host) => None,
            FEED_HOST | BACKUP_FEED_HOST => Some(PLAIN_FEED.as_bytes().to_vec()),
            CHAT_HOST => {
                let body = call.body.as_deref()?;
                if names("chat") || broken.iter().any(|model| body.contains(model)) {
                    return None;
                }
                Some(chat_reply(r#"{"risk_flag":true,"confidence":80}"#))
            }
            _ => market_reply(call),
        }
    }
}

fn hosts_called(ai_key: Option<&str>, broken: &'static [&'static str]) -> Vec<&'static str> {
    let mut hosts = Vec::new();
    let mut inner = world(broken);
    observe(&secret(ai_key), |call: &Call| {
        hosts.push(call.host);
        inner(call)
    });
    hosts
}

fn chat_call_of(ai_key: &str) -> (Vec<(&'static str, String)>, serde_json::Value) {
    let mut seen = None;
    let mut inner = world(&[]);
    observe(&secret(Some(ai_key)), |call: &Call| {
        if call.host == CHAT_HOST {
            seen = Some((
                call.headers.clone(),
                serde_json::from_str(call.body.as_deref().unwrap()).unwrap(),
            ));
        }
        inner(call)
    });
    seen.unwrap()
}

#[test]
fn titles_come_from_the_items_only() {
    let titles = read_titles(PLAIN_FEED.as_bytes()).unwrap();

    assert_eq!(titles, ["First headline", "Second headline"]);
}

#[test]
fn cdata_titles_are_unwrapped() {
    let titles = read_titles(CDATA_FEED.as_bytes()).unwrap();

    assert_eq!(titles, ["Bridge drained on chain X"]);
}

#[test]
fn a_feed_without_items_is_refused() {
    assert_eq!(
        read_titles(b"<rss><channel><title>Empty</title></channel></rss>"),
        None
    );
}

#[test]
fn garbage_is_not_a_feed() {
    assert_eq!(read_titles(b"<html>blocked</html>"), None);
    assert_eq!(read_titles(&[0xff, 0xfe, 0x00]), None);
}

#[test]
fn an_item_without_a_title_is_skipped() {
    let feed = "<item><link>x</link></item><item><title>Kept</title></item>";

    assert_eq!(read_titles(feed.as_bytes()).unwrap(), ["Kept"]);
}

#[test]
fn control_characters_are_dropped_from_titles() {
    let feed = "<item><title>One\n\nTwo\u{7}</title></item>";

    assert_eq!(read_titles(feed.as_bytes()).unwrap(), ["OneTwo"]);
}

#[test]
fn the_number_of_titles_is_capped() {
    let feed = "<item><title>Headline</title></item>".repeat(MAX_TITLES + 5);

    assert_eq!(read_titles(feed.as_bytes()).unwrap().len(), MAX_TITLES);
}

#[test]
fn the_length_of_a_title_is_capped() {
    let feed = format!(
        "<item><title>{}</title></item>",
        "é".repeat(MAX_TITLE_CHARS + 5)
    );

    let titles = read_titles(feed.as_bytes()).unwrap();

    assert_eq!(titles[0].chars().count(), MAX_TITLE_CHARS);
}

#[test]
fn a_clear_answer_gives_a_clear_flag() {
    assert_eq!(
        answer_of(r#"{"risk_flag":false,"confidence":90}"#),
        Some((AI_CLEAR, 90))
    );
}

#[test]
fn a_raised_flag_gives_a_raised_flag() {
    assert_eq!(
        answer_of(r#"{"risk_flag":true,"confidence":70}"#),
        Some((AI_FLAGGED, 70))
    );
}

#[test]
fn spaces_around_the_answer_are_fine() {
    assert_eq!(
        answer_of(" {\"risk_flag\":false,\"confidence\":1}\n"),
        Some((AI_CLEAR, 1))
    );
}

#[test]
fn prose_is_not_an_answer() {
    assert_eq!(answer_of("All clear, nothing to report."), None);
}

#[test]
fn an_answer_in_a_code_fence_is_not_an_answer() {
    assert_eq!(
        answer_of("```json\n{\"risk_flag\":false,\"confidence\":90}\n```"),
        None
    );
}

#[test]
fn an_answer_with_extra_fields_is_not_an_answer() {
    assert_eq!(
        answer_of(r#"{"risk_flag":false,"confidence":90,"action":"buy"}"#),
        None
    );
}

#[test]
fn an_answer_without_a_flag_is_not_an_answer() {
    assert_eq!(answer_of(r#"{"confidence":90}"#), None);
}

#[test]
fn a_confidence_past_a_hundred_is_not_an_answer() {
    assert_eq!(answer_of(r#"{"risk_flag":false,"confidence":101}"#), None);
}

#[test]
fn a_confidence_outside_the_type_is_not_an_answer() {
    assert_eq!(answer_of(r#"{"risk_flag":false,"confidence":0.9}"#), None);
    assert_eq!(answer_of(r#"{"risk_flag":false,"confidence":-1}"#), None);
    assert_eq!(
        answer_of(r#"{"risk_flag":false,"confidence":"high"}"#),
        None
    );
}

#[test]
fn a_flag_that_is_not_a_boolean_is_not_an_answer() {
    assert_eq!(answer_of(r#"{"risk_flag":"false","confidence":90}"#), None);
    assert_eq!(answer_of(r#"{"risk_flag":0,"confidence":90}"#), None);
}

#[test]
fn a_cut_off_answer_is_not_an_answer() {
    let reply = reply_with(CHAT_ID, r#"{"risk_flag":false,"confidence":90}"#, "length");

    assert!(read_advice(&reply).is_none());
}

#[test]
fn a_reply_without_a_choice_is_not_an_answer() {
    let reply = json!({"id": CHAT_ID, "choices": []}).to_string();

    assert!(read_advice(reply.as_bytes()).is_none());
}

#[test]
fn a_reply_with_two_choices_is_not_an_answer() {
    let choice = json!({"finish_reason": "stop", "message": {"content": r#"{"risk_flag":false,"confidence":90}"#}});
    let reply = json!({"id": CHAT_ID, "choices": [choice, choice]}).to_string();

    assert!(read_advice(reply.as_bytes()).is_none());
}

#[test]
fn an_api_error_is_not_an_answer() {
    assert!(read_advice(br#"{"error":{"message":"out of credit"}}"#).is_none());
}

#[test]
fn a_chat_id_that_could_swell_the_decision_is_refused() {
    let reply = reply_with(
        &"a".repeat(65),
        r#"{"risk_flag":false,"confidence":90}"#,
        "stop",
    );

    assert!(read_advice(&reply).is_none());
}

#[test]
fn a_chat_id_with_odd_characters_is_refused() {
    let reply = reply_with("chat\"id", r#"{"risk_flag":false,"confidence":90}"#, "stop");

    assert!(read_advice(&reply).is_none());
}

#[test]
fn an_empty_chat_id_is_refused() {
    let reply = reply_with("", r#"{"risk_flag":false,"confidence":90}"#, "stop");

    assert!(read_advice(&reply).is_none());
}

#[test]
fn the_reference_points_at_the_signed_reply() {
    let reply = chat_reply(r#"{"risk_flag":false,"confidence":90}"#);
    let expected: String = Sha256::digest(&reply)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    let advice = read_advice(&reply).unwrap();

    assert_eq!(advice.ai_ref.chat_id, CHAT_ID);
    assert_eq!(advice.ai_ref.resp_sig_hash, expected);
}

#[test]
fn the_advice_lands_in_the_reading() {
    let reading = observe(&secret(Some(KEY)), world(&[])).unwrap();

    assert_eq!(reading.obs.ai_flag, AI_FLAGGED);
    assert_eq!(reading.obs.ai_conf, 80);
    assert_eq!(reading.ai_ref.chat_id, CHAT_ID);
    assert_eq!(reading.obs.pb, 390_000_000);
}

#[test]
fn no_key_leaves_the_advisor_silent_and_makes_no_call() {
    let reading = observe(&secret(None), world(&[])).unwrap();

    assert_eq!(reading.obs.ai_flag, AI_SILENT);
    assert_eq!(reading.ai_ref, AiRef::default());
    assert!(!hosts_called(None, &[]).contains(&CHAT_HOST));
}

#[test]
fn a_market_that_cannot_be_read_spends_no_credit() {
    assert_eq!(observe(&secret(Some(KEY)), world(&["trades"])), None);
    assert!(!hosts_called(Some(KEY), &["trades"]).contains(&CHAT_HOST));
}

#[test]
fn the_backup_feed_is_used_when_the_first_fails() {
    let hosts = hosts_called(Some(KEY), &[FEED_HOST]);

    assert!(hosts.contains(&BACKUP_FEED_HOST));
    assert!(hosts.contains(&CHAT_HOST));
}

#[test]
fn the_backup_feed_is_left_alone_when_the_first_works() {
    assert!(!hosts_called(Some(KEY), &[]).contains(&BACKUP_FEED_HOST));
}

#[test]
fn no_feed_leaves_the_advisor_silent_and_spends_no_credit() {
    let broken = &[FEED_HOST, BACKUP_FEED_HOST];

    let reading = observe(&secret(Some(KEY)), world(broken)).unwrap();

    assert_eq!(reading.obs.ai_flag, AI_SILENT);
    assert!(!hosts_called(Some(KEY), broken).contains(&CHAT_HOST));
}

#[test]
fn the_second_model_answers_when_the_first_is_gone() {
    static FIRST: [&str; 1] = [MODELS[0]];

    let reading = observe(&secret(Some(KEY)), world(&FIRST)).unwrap();

    assert_eq!(reading.obs.ai_flag, AI_FLAGGED);
}

#[test]
fn no_model_leaves_the_advisor_silent() {
    let reading = observe(&secret(Some(KEY)), world(&["chat"])).unwrap();

    assert_eq!(reading.obs.ai_flag, AI_SILENT);
    assert_eq!(reading.obs.pb, 390_000_000);
    assert_eq!(reading.ai_ref, AiRef::default());
}

#[test]
fn the_key_goes_only_to_the_chat_host() {
    let mut carried = Vec::new();
    let mut inner = world(&[]);
    observe(&secret(Some(KEY)), |call: &Call| {
        if !call.headers.is_empty() {
            carried.push(call.host);
        }
        inner(call)
    });

    assert_eq!(carried, [CHAT_HOST]);
}

#[test]
fn the_key_stays_out_of_the_request_body() {
    let (headers, body) = chat_call_of(KEY);

    assert!(headers.contains(&("authorization", format!("Bearer {KEY}"))));
    assert!(!body.to_string().contains(KEY));
}

#[test]
fn the_chat_call_asks_for_the_model_it_names() {
    // Without it the gateway may answer from another model, whose TEE did not sign.
    let (headers, _) = chat_call_of(KEY);

    assert!(headers.contains(&("x-no-aliasing", "true".to_string())));
}

#[test]
fn the_sealed_prompt_is_the_system_message() {
    let (_, body) = chat_call_of(KEY);

    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][0]["content"], PROMPT);
}

#[test]
fn the_headlines_are_the_user_message() {
    let (_, body) = chat_call_of(KEY);

    assert_eq!(body["messages"][1]["role"], "user");
    assert_eq!(
        body["messages"][1]["content"],
        "First headline\nSecond headline"
    );
}

#[test]
fn the_request_can_be_signed_and_stays_deterministic() {
    let (_, body) = chat_call_of(KEY);

    assert_eq!(body["model"], MODELS[0]);
    assert_eq!(body["stream"], false);
    assert_eq!(body["temperature"], 0);
}

/// The chat bodies a run sends, with the first model answering `first` when given.
fn chat_bodies(
    first: Option<&'static str>,
    broken: &'static [&'static str],
) -> (Option<Observed>, Vec<serde_json::Value>) {
    let mut bodies = Vec::new();
    let mut inner = world(broken);
    let reading = observe(&secret(Some(KEY)), |call: &Call| {
        if call.host != CHAT_HOST {
            return inner(call);
        }
        let body: serde_json::Value = serde_json::from_str(call.body.as_deref().unwrap()).unwrap();
        let asked_first = body["model"] == MODELS[0];
        bodies.push(body);
        match first {
            Some(content) if asked_first => Some(chat_reply(content)),
            _ => inner(call),
        }
    });
    (reading, bodies)
}

#[test]
fn a_bad_answer_from_the_first_model_is_not_asked_again() {
    let fenced = "```json\n{\"risk_flag\":true,\"confidence\":95}\n```";

    let (reading, bodies) = chat_bodies(Some(fenced), &[]);

    assert_eq!(reading.unwrap().obs.ai_flag, AI_SILENT);
    assert_eq!(bodies.len(), 1);
}

#[test]
fn the_first_model_reasons_only_briefly() {
    let (_, bodies) = chat_bodies(None, &[]);

    assert_eq!(bodies[0]["model"], MODELS[0]);
    assert_eq!(bodies[0]["reasoning_effort"], "low");
    assert!(bodies[0].get("chat_template_kwargs").is_none());
}

#[test]
fn the_second_model_does_not_reason() {
    let (_, bodies) = chat_bodies(None, &[MODELS[0]]);

    assert_eq!(bodies[1]["model"], MODELS[1]);
    assert_eq!(bodies[1]["chat_template_kwargs"]["enable_thinking"], false);
    assert!(bodies[1].get("reasoning_effort").is_none());
}

#[test]
fn the_answer_has_room_after_brief_reasoning() {
    let (_, bodies) = chat_bodies(None, &[]);

    assert!(bodies[0]["max_tokens"].as_u64().unwrap() >= 256);
}

#[test]
fn a_reply_whose_reasoning_ran_out_is_not_an_answer() {
    let reply = json!({"id": CHAT_ID, "choices": [{"finish_reason": "length",
        "message": {"content": null, "reasoning_content": "Let me think"}}]})
    .to_string();

    assert!(read_advice(reply.as_bytes()).is_none());
}

#[test]
fn a_blank_title_is_skipped() {
    let feed = "<item><title>   </title></item><item><title> Kept </title></item>";

    assert_eq!(read_titles(feed.as_bytes()).unwrap(), ["Kept"]);
}

#[test]
fn a_feed_of_blank_titles_is_no_feed() {
    assert_eq!(read_titles(b"<item><title> </title></item>"), None);
}

#[test]
fn cdata_with_space_around_it_is_unwrapped() {
    let feed = "<item><title>\n  <![CDATA[Bridge drained]]>\n</title></item>";

    assert_eq!(read_titles(feed.as_bytes()).unwrap(), ["Bridge drained"]);
}

#[test]
fn a_flag_from_the_advisor_blocks_a_buy_at_the_end() {
    let mut flagged = Obs {
        pa: 430_000_000,
        pb: 430_000_000,
        ta: 1,
        tb: 1,
        ai_flag: AI_CLEAR,
        ai_conf: 90,
    };
    let params = secret(None).params;
    let input = Input {
        now: 1,
        ..serde_json::from_str(include_str!("../fixtures/input.json")).unwrap()
    };
    assert_eq!(decide(&params, &input, &flagged).action, Action::BuyRisk);

    flagged.ai_flag = AI_FLAGGED;

    assert_eq!(decide(&params, &input, &flagged).action, Action::None);
}
