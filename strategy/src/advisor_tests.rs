use serde_json::json;
use sha2::{Digest, Sha256};

use super::advisor::{
    clean_note, market_line, observe, read_advice, read_ticker, read_titles, Advice,
    MAX_NOTE_CHARS, MAX_TITLES, MAX_TITLE_CHARS, MODELS,
};
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
const NONCE: u64 = 7;
const SALT_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

fn reply_with(id: &str, content: &str, finish_reason: &str) -> Vec<u8> {
    reply_from(MODELS[0], id, content, finish_reason)
}

fn reply_from(model: &str, id: &str, content: &str, finish_reason: &str) -> Vec<u8> {
    json!({"id": id, "model": model, "choices": [{"index": 0, "finish_reason": finish_reason,
        "message": {"role": "assistant", "content": content}}]})
    .to_string()
    .into_bytes()
}

fn chat_reply(content: &str) -> Vec<u8> {
    reply_with(CHAT_ID, content, "stop")
}

/// What the first model's reply reads as.
fn advice_of(reply: &[u8]) -> Option<Advice> {
    read_advice(reply, 0)
}

fn answer_of(content: &str) -> Option<(u8, u8)> {
    advice_of(&chat_reply(content)).map(|advice| (advice.ai_risk, advice.ai_conf))
}

fn secret(ai_key: Option<&str>) -> Secret {
    Secret {
        chain: "testnet".into(),
        wasm_hash: "bb".into(),
        salt: SALT_HEX.into(),
        params: Params {
            risk_on_above: 420_000_000,
            risk_off_below: 400_000_000,
            source_dev_bps: 100,
            buy_usdc: 1_000,
            sell_wnear: 2_000,
            prompt: PROMPT.into(),
            ai_veto_at: Some(50),
            ai_exit_at: Some(80),
            ai_exit_conf: Some(70),
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
                // The API names the model that answered, as the real one does.
                let asked: serde_json::Value = serde_json::from_str(body).ok()?;
                let model = asked["model"].as_str()?;
                Some(reply_from(
                    model,
                    CHAT_ID,
                    r#"{"risk":85,"confidence":80,"note":"Exploit reported."}"#,
                    "stop",
                ))
            }
            _ => market_reply(call),
        }
    }
}

fn hosts_called(ai_key: Option<&str>, broken: &'static [&'static str]) -> Vec<&'static str> {
    let mut hosts = Vec::new();
    let mut inner = world(broken);
    observe(&secret(ai_key), NONCE, |call: &Call| {
        hosts.push(call.host);
        inner(call)
    });
    hosts
}

fn chat_call_of(ai_key: &str) -> (Vec<(&'static str, String)>, serde_json::Value) {
    let mut seen = None;
    let mut inner = world(&[]);
    observe(&secret(Some(ai_key)), NONCE, |call: &Call| {
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
fn a_low_risk_answer_is_read() {
    assert_eq!(
        answer_of(r#"{"risk":10,"confidence":90,"note":"Quiet news."}"#),
        Some((10, 90))
    );
}

#[test]
fn a_high_risk_answer_is_read() {
    assert_eq!(
        answer_of(r#"{"risk":85,"confidence":70,"note":"Exploit reported."}"#),
        Some((85, 70))
    );
}

#[test]
fn spaces_around_the_answer_are_fine() {
    assert_eq!(
        answer_of(" {\"risk\":10,\"confidence\":1,\"note\":\"Quiet news.\"}\n"),
        Some((10, 1))
    );
}

#[test]
fn prose_is_not_an_answer() {
    assert_eq!(answer_of("All clear, nothing to report."), None);
}

// Lead decision 2026-11-07: a sealed vault cannot adapt if a model starts fencing its
// answer, so one exact fence is peeled off. What is inside must still be the exact answer.
#[test]
fn an_answer_in_a_json_fence_is_an_answer() {
    assert_eq!(
        answer_of("```json\n{\"risk\":10,\"confidence\":90,\"note\":\"Quiet news.\"}\n```"),
        Some((10, 90))
    );
}

#[test]
fn an_answer_in_a_bare_fence_is_an_answer() {
    assert_eq!(
        answer_of(" ```\n{\"risk\":85,\"confidence\":55,\"note\":\"Exploit reported.\"}\n```\n"),
        Some((85, 55))
    );
}

#[test]
fn text_around_a_fence_is_not_an_answer() {
    assert_eq!(
        answer_of(
            "Here it is:\n```json\n{\"risk\":10,\"confidence\":90,\"note\":\"Quiet news.\"}\n```"
        ),
        None
    );
}

#[test]
fn a_fence_that_is_never_closed_is_not_an_answer() {
    assert_eq!(
        answer_of("```json\n{\"risk\":10,\"confidence\":90,\"note\":\"Quiet news.\"}"),
        None
    );
}

#[test]
fn a_fence_for_another_language_is_not_an_answer() {
    assert_eq!(
        answer_of("```python\n{\"risk\":10,\"confidence\":90,\"note\":\"Quiet news.\"}\n```"),
        None
    );
}

#[test]
fn a_fenced_answer_with_extra_fields_is_not_an_answer() {
    assert_eq!(
        answer_of(
            "```json\n{\"risk\":10,\"confidence\":90,\"note\":\"Quiet news.\",\"why\":\"x\"}\n```"
        ),
        None
    );
}

#[test]
fn two_fences_are_not_an_answer() {
    assert_eq!(
        answer_of(
            "```json\n```json\n{\"risk\":10,\"confidence\":90,\"note\":\"Quiet news.\"}\n```\n```"
        ),
        None
    );
}

#[test]
fn an_answer_with_extra_fields_is_not_an_answer() {
    assert_eq!(
        answer_of(r#"{"risk":10,"confidence":90,"note":"Quiet news.","action":"buy"}"#),
        None
    );
}

#[test]
fn an_answer_without_a_risk_is_not_an_answer() {
    assert_eq!(answer_of(r#"{"confidence":90,"note":"x"}"#), None);
}

#[test]
fn an_answer_without_a_note_is_not_an_answer() {
    assert_eq!(answer_of(r#"{"risk":10,"confidence":90}"#), None);
}

#[test]
fn the_old_flag_answer_is_not_an_answer() {
    assert_eq!(answer_of(r#"{"risk_flag":false,"confidence":90}"#), None);
}

#[test]
fn a_risk_past_a_hundred_is_not_an_answer() {
    assert_eq!(
        answer_of(r#"{"risk":101,"confidence":90,"note":"x"}"#),
        None
    );
}

#[test]
fn a_confidence_past_a_hundred_is_not_an_answer() {
    assert_eq!(
        answer_of(r#"{"risk":10,"confidence":101,"note":"Quiet news."}"#),
        None
    );
}

#[test]
fn a_confidence_outside_the_type_is_not_an_answer() {
    assert_eq!(
        answer_of(r#"{"risk":10,"confidence":0.9,"note":"Quiet news."}"#),
        None
    );
    assert_eq!(
        answer_of(r#"{"risk":10,"confidence":-1,"note":"Quiet news."}"#),
        None
    );
    assert_eq!(
        answer_of(r#"{"risk":10,"confidence":"high","note":"Quiet news."}"#),
        None
    );
}

#[test]
fn a_risk_that_is_not_a_whole_number_is_not_an_answer() {
    assert_eq!(
        answer_of(r#"{"risk":"10","confidence":90,"note":"x"}"#),
        None
    );
    assert_eq!(
        answer_of(r#"{"risk":true,"confidence":90,"note":"x"}"#),
        None
    );
    assert_eq!(
        answer_of(r#"{"risk":10.5,"confidence":90,"note":"x"}"#),
        None
    );
}

#[test]
fn a_cut_off_answer_is_not_an_answer() {
    let reply = reply_with(
        CHAT_ID,
        r#"{"risk":10,"confidence":90,"note":"Quiet news."}"#,
        "length",
    );

    assert!(advice_of(&reply).is_none());
}

#[test]
fn a_reply_without_a_choice_is_not_an_answer() {
    let reply = json!({"id": CHAT_ID, "choices": []}).to_string();

    assert!(advice_of(reply.as_bytes()).is_none());
}

#[test]
fn a_reply_with_two_choices_is_not_an_answer() {
    let choice = json!({"finish_reason": "stop", "message": {"content": r#"{"risk":10,"confidence":90,"note":"Quiet news."}"#}});
    let reply = json!({"id": CHAT_ID, "choices": [choice, choice]}).to_string();

    assert!(advice_of(reply.as_bytes()).is_none());
}

#[test]
fn an_api_error_is_not_an_answer() {
    assert!(advice_of(br#"{"error":{"message":"out of credit"}}"#).is_none());
}

#[test]
fn a_chat_id_that_could_swell_the_decision_is_refused() {
    let reply = reply_with(
        &"a".repeat(65),
        r#"{"risk":10,"confidence":90,"note":"Quiet news."}"#,
        "stop",
    );

    assert!(advice_of(&reply).is_none());
}

#[test]
fn a_chat_id_with_odd_characters_is_refused() {
    let reply = reply_with(
        "chat\"id",
        r#"{"risk":10,"confidence":90,"note":"Quiet news."}"#,
        "stop",
    );

    assert!(advice_of(&reply).is_none());
}

#[test]
fn an_empty_chat_id_is_refused() {
    let reply = reply_with(
        "",
        r#"{"risk":10,"confidence":90,"note":"Quiet news."}"#,
        "stop",
    );

    assert!(advice_of(&reply).is_none());
}

#[test]
fn the_reference_points_at_the_signed_reply() {
    let reply = chat_reply(r#"{"risk":10,"confidence":90,"note":"Quiet news."}"#);
    let expected: String = Sha256::digest(&reply)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    let advice = advice_of(&reply).unwrap();

    assert_eq!(advice.ai_ref.chat_id, CHAT_ID);
    assert_eq!(advice.ai_ref.resp_sig_hash, expected);
}

#[test]
fn the_advice_lands_in_the_reading() {
    let reading = observe(&secret(Some(KEY)), NONCE, world(&[])).unwrap();

    assert_eq!(reading.obs.ai_flag, AI_CLEAR);
    assert_eq!(reading.obs.ai_risk, Some(85));
    assert_eq!(reading.obs.ai_conf, 80);
    assert_eq!(reading.ai_ref.chat_id, CHAT_ID);
    assert_eq!(reading.obs.pb, 390_000_000);
}

#[test]
fn no_key_leaves_the_advisor_silent_and_makes_no_call() {
    let reading = observe(&secret(None), NONCE, world(&[])).unwrap();

    assert_eq!(reading.obs.ai_flag, AI_SILENT);
    assert_eq!(reading.ai_ref, AiRef::default());
    assert!(!hosts_called(None, &[]).contains(&CHAT_HOST));
}

#[test]
fn a_market_that_cannot_be_read_spends_no_credit() {
    assert_eq!(observe(&secret(Some(KEY)), NONCE, world(&["trades"])), None);
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

    let reading = observe(&secret(Some(KEY)), NONCE, world(broken)).unwrap();

    assert_eq!(reading.obs.ai_flag, AI_SILENT);
    assert!(!hosts_called(Some(KEY), broken).contains(&CHAT_HOST));
}

#[test]
fn the_second_model_answers_when_the_first_is_gone() {
    static FIRST: [&str; 1] = [MODELS[0]];

    let reading = observe(&secret(Some(KEY)), NONCE, world(&FIRST)).unwrap();

    assert_eq!(reading.obs.ai_risk, Some(85));
}

#[test]
fn no_model_leaves_the_advisor_silent() {
    let reading = observe(&secret(Some(KEY)), NONCE, world(&["chat"])).unwrap();

    assert_eq!(reading.obs.ai_flag, AI_SILENT);
    assert_eq!(reading.obs.pb, 390_000_000);
    assert_eq!(reading.ai_ref, AiRef::default());
}

#[test]
fn the_key_goes_only_to_the_chat_host() {
    let mut carried = Vec::new();
    let mut inner = world(&[]);
    observe(&secret(Some(KEY)), NONCE, |call: &Call| {
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
fn the_headlines_and_the_market_are_the_user_message() {
    let (_, body) = chat_call_of(KEY);

    assert_eq!(body["messages"][1]["role"], "user");
    assert_eq!(
        body["messages"][1]["content"],
        format!(
            "First headline\nSecond headline\n\nMarket: NEAR/USD Rhea pool 3.9000, Kraken 3.9000\n\nref:{}",
            tag_of(SALT_HEX, NONCE)
        )
    );
}

/// The tag written out by hand: SHA-256 of the domain, then each field after its u32 length.
fn tag_of(salt_hex: &str, nonce: u64) -> String {
    let salt: Vec<u8> = (0..salt_hex.len())
        .step_by(2)
        .map(|start| u8::from_str_radix(&salt_hex[start..start + 2], 16).unwrap())
        .collect();
    let mut hasher = Sha256::new();
    hasher.update(b"foundling/v1/request-tag");
    for field in [salt.as_slice(), &nonce.to_be_bytes()] {
        hasher.update((field.len() as u32).to_be_bytes());
        hasher.update(field);
    }
    to_hex(&hasher.finalize())
}

fn headlines_sent(salt_hex: &'static str, nonce: u64) -> String {
    let mut sent = None;
    let mut inner = world(&[]);
    let secret = Secret {
        salt: salt_hex.into(),
        ..secret(Some(KEY))
    };
    observe(&secret, nonce, |call: &Call| {
        if call.host == CHAT_HOST {
            let body: serde_json::Value =
                serde_json::from_str(call.body.as_deref().unwrap()).unwrap();
            sent = Some(body["messages"][1]["content"].as_str().unwrap().to_string());
        }
        inner(call)
    });
    sent.unwrap()
}

#[test]
fn the_request_carries_a_tag_only_the_salt_can_give() {
    // Without it, the request hash NEAR AI signs is a hash of the prompt and public
    // headlines alone, and anyone holding the signature could test guesses of the prompt.
    let other_salt = "ff".repeat(32);

    assert_ne!(
        headlines_sent(SALT_HEX, NONCE),
        headlines_sent(Box::leak(other_salt.into_boxed_str()), NONCE)
    );
}

#[test]
fn the_tag_changes_with_each_cycle() {
    assert_ne!(headlines_sent(SALT_HEX, 1), headlines_sent(SALT_HEX, 2));
}

#[test]
fn a_secret_whose_salt_cannot_be_read_spends_no_credit() {
    let secret = Secret {
        salt: "zz".into(),
        ..secret(Some(KEY))
    };

    let reading = observe(&secret, NONCE, world(&[])).unwrap();

    assert_eq!(reading.obs.ai_flag, AI_SILENT);
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
    let reading = observe(&secret(Some(KEY)), NONCE, |call: &Call| {
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
    let prose = "Risk looks high, I would hold off.";

    let (reading, bodies) = chat_bodies(Some(prose), &[]);

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

    assert!(advice_of(reply.as_bytes()).is_none());
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
fn a_risk_from_the_advisor_vetoes_a_buy_at_the_end() {
    let mut reading = Obs {
        pa: 430_000_000,
        pb: 430_000_000,
        ta: 1,
        tb: 1,
        ai_flag: AI_CLEAR,
        ai_conf: 90,
        ai_risk: Some(10),
    };
    let params = secret(None).params;
    let input = Input {
        now: 1,
        ..serde_json::from_str(include_str!("../fixtures/input.json")).unwrap()
    };
    assert_eq!(decide(&params, &input, &reading).action, Action::BuyRisk);

    reading.ai_risk = Some(60);

    assert_eq!(decide(&params, &input, &reading).action, Action::None);
}

#[test]
fn the_reading_names_the_second_model_when_it_answers() {
    static FIRST: [&str; 1] = [MODELS[0]];

    let reading = observe(&secret(Some(KEY)), NONCE, world(&FIRST)).unwrap();

    assert_eq!(reading.ai_ref.m, Some(1));
}

#[test]
fn a_silent_advisor_names_no_model() {
    let reading = observe(&secret(None), NONCE, world(&[])).unwrap();

    assert_eq!(reading.ai_ref.m, None);
    let json = serde_json::to_string(&reading.ai_ref).unwrap();
    assert_eq!(json, r#"{"chat_id":"","resp_sig_hash":""}"#);
}

/// The reply GLM-5.3 Flash gave on 2026-11-06 to a run of this WASM with a real key. NEAR
/// AI's `provider_tee` signature for it names this model and this `resp_sig_hash`.
const LIVE_REPLY: &str = r#"{"id":"96c4d660c8c24433aafa9eac77b20286","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"{\"risk_flag\": true, \"confidence\": 70}"},"finish_reason":"stop","logprobs":null,"matched_stop":154827}],"model":"z-ai/glm-5.3-flash","created":1793981881,"usage":{"prompt_tokens":496,"total_tokens":510,"completion_tokens":14,"prompt_tokens_details":null,"reasoning_tokens":1,"completion_tokens_details":{"reasoning_tokens":1}}}"#;

#[test]
fn the_reply_seen_live_in_the_old_format_is_not_an_answer() {
    assert!(advice_of(LIVE_REPLY.as_bytes()).is_none());
}

#[test]
fn the_live_reply_shape_with_a_risk_answer_reads_as_an_answer() {
    let reply = LIVE_REPLY.replace(
        r#"{\"risk_flag\": true, \"confidence\": 70}"#,
        r#"{\"risk\": 72, \"confidence\": 70, \"note\": \"Exploit on a NEAR DEX.\"}"#,
    );

    let advice = advice_of(reply.as_bytes()).unwrap();

    assert_eq!((advice.ai_risk, advice.ai_conf), (72, 70));
    assert_eq!(
        advice.ai_ref.note.as_deref(),
        Some("Exploit on a NEAR DEX.")
    );
    assert_eq!(advice.ai_ref.chat_id, "96c4d660c8c24433aafa9eac77b20286");
    assert_eq!(
        advice.ai_ref.resp_sig_hash,
        to_hex(&Sha256::digest(reply.as_bytes()))
    );
    assert_eq!(advice.ai_ref.m, Some(0));
}

#[test]
fn a_note_keeps_only_safe_characters() {
    assert_eq!(
        clean_note("Rhea \"exploit\" <b>now</b>\n; 40% (est.)"),
        "Rhea  exploit   b now /b  ; 40% (est.)"
    );
}

#[test]
fn a_note_is_cut_to_its_limit() {
    let long = "a".repeat(MAX_NOTE_CHARS + 30);

    assert_eq!(clean_note(&long).len(), MAX_NOTE_CHARS);
}

#[test]
fn a_note_of_only_unsafe_characters_is_no_note() {
    let reply = chat_reply(r#"{"risk":10,"confidence":90,"note":"\u00e9\u00e9"}"#);

    assert_eq!(advice_of(&reply).unwrap().ai_ref.note, None);
}

#[test]
fn the_risk_and_the_note_land_in_the_reading() {
    let reading = observe(&secret(Some(KEY)), NONCE, world(&[])).unwrap();

    assert_eq!(reading.obs.ai_flag, AI_CLEAR);
    assert_eq!(reading.obs.ai_risk, Some(85));
    assert_eq!(reading.obs.ai_conf, 80);
    assert_eq!(reading.ai_ref.note.as_deref(), Some("Exploit reported."));
}

#[test]
fn a_silent_advisor_records_no_risk() {
    let reading = observe(&secret(None), NONCE, world(&[])).unwrap();

    assert_eq!(reading.obs.ai_risk, None);
    assert_eq!(reading.ai_ref.note, None);
}

const TICKER: &str = r#"{"error":[],"result":{"NEARUSD":{"a":["3.64","1","1"],"b":["3.63","1","1"],"c":["3.64","1"],"v":["1","1"],"p":["3.6","3.6"],"t":[1,1],"l":["3.55","3.50"],"h":["3.85","3.90"],"o":"3.80"}}}"#;

#[test]
fn the_ticker_gives_the_open_and_the_day_range() {
    assert_eq!(
        read_ticker(TICKER.as_bytes()),
        Some((380_000_000, 390_000_000, 350_000_000))
    );
}

#[test]
fn a_ticker_with_an_error_is_no_ticker() {
    assert_eq!(
        read_ticker(br#"{"error":["EQuery:Unknown asset pair"],"result":{}}"#),
        None
    );
    assert_eq!(read_ticker(b"not json"), None);
}

#[test]
fn the_market_line_shows_both_prices_and_the_day() {
    let market = Obs {
        pa: 363_561_001,
        pb: 364_506_841,
        ta: 1,
        tb: 1,
        ai_flag: AI_SILENT,
        ai_conf: 0,
        ai_risk: None,
    };

    assert_eq!(
        market_line(&market, Some((380_000_000, 390_000_000, 350_000_000))),
        "Market: NEAR/USD Rhea pool 3.6356, Kraken 3.6450, today's open 3.8000, 24h high 3.9000, 24h low 3.5000"
    );
    assert_eq!(
        market_line(&market, None),
        "Market: NEAR/USD Rhea pool 3.6356, Kraken 3.6450"
    );
}

fn user_message_with(ticker: Option<&'static str>) -> String {
    let mut inner = world(&[]);
    let mut message = String::new();
    observe(&secret(Some(KEY)), NONCE, |call: &Call| {
        if call.path.starts_with("/0/public/Ticker") {
            return ticker.map(|reply| reply.as_bytes().to_vec());
        }
        if call.host == CHAT_HOST {
            let body: serde_json::Value =
                serde_json::from_str(call.body.as_deref().unwrap()).unwrap();
            message = body["messages"][1]["content"].as_str().unwrap().to_string();
        }
        inner(call)
    });
    message
}

#[test]
fn the_advisor_is_told_the_market_and_the_day() {
    let message = user_message_with(Some(TICKER));

    assert!(message.contains("\n\nMarket: NEAR/USD Rhea pool 3.9000, Kraken 3.9000, today's open 3.8000, 24h high 3.9000, 24h low 3.5000\n\nref:"), "{message}");
}

#[test]
fn a_ticker_that_fails_only_drops_the_day() {
    let message = user_message_with(None);

    assert!(
        message.contains("\n\nMarket: NEAR/USD Rhea pool 3.9000, Kraken 3.9000\n\nref:"),
        "{message}"
    );
}
