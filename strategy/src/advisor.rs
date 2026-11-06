//! The NEAR AI tripwire. It reads public headlines and answers with one flag that can only
//! brake: a raised flag blocks a buy, and it cannot start or size anything. Whatever goes
//! wrong here leaves the advisor silent, and a silent advisor ends in a hold.

use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::sources::{observe_market, Call};
use crate::{to_hex, AiRef, Obs, Secret, AI_CLEAR, AI_FLAGGED};

/// General crypto news: The Block first, Cointelegraph if that feed is down.
const FEEDS: [(&str, &str); 2] = [
    ("www.theblock.co", "/rss.xml"),
    ("cointelegraph.com", "/rss"),
];
const CHAT_HOST: &str = "cloud-api.near.ai";
const CHAT_PATH: &str = "/v1/chat/completions";
/// Both run inside NEAR's own TEE tier. The list of models changes, and a sealed vault
/// cannot, so the second is asked only when the first cannot be reached. A first model that
/// answers badly leaves the advisor silent: asking again would let a second opinion undo a
/// raised flag.
pub const MODELS: [&str; 2] = ["z-ai/glm-5.3-flash", "Qwen/Qwen3.8-27B"];
/// Both models reason by default and the reasoning counts against this, so it leaves room
/// for the few tokens they still spend before the answer.
const MAX_OUTPUT_TOKENS: u32 = 256;
pub const MAX_TITLES: usize = 20;
pub const MAX_TITLE_CHARS: usize = 160;
const MAX_CONFIDENCE: u8 = 100;
const MAX_CHAT_ID_BYTES: usize = 64;
const FINISHED: &str = "stop";

#[derive(Debug, PartialEq)]
pub struct Advice {
    pub ai_flag: u8,
    pub ai_conf: u8,
    pub ai_ref: AiRef,
}

/// What a run saw: `ai_ref` points at the signed reply that `obs` carries the flag of.
#[derive(Debug, PartialEq)]
pub struct Observed {
    pub obs: Obs,
    pub ai_ref: AiRef,
}

impl From<Obs> for Observed {
    fn from(obs: Obs) -> Self {
        Self {
            obs,
            ai_ref: AiRef::default(),
        }
    }
}

#[derive(Deserialize)]
struct Chat {
    id: String,
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    finish_reason: String,
    message: Message,
}

#[derive(Deserialize)]
struct Message {
    content: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    risk_flag: bool,
    confidence: u8,
}

/// Prices first: a market that cannot be read ends the run without spending credit.
pub fn observe(
    secret: &Secret,
    mut send: impl FnMut(&Call) -> Option<Vec<u8>>,
) -> Option<Observed> {
    let obs = observe_market(&mut send)?;
    let Some(key) = secret.ai_key.as_deref() else {
        return Some(obs.into());
    };
    let Some(advice) = ask(&secret.params.prompt, key, &mut send) else {
        return Some(obs.into());
    };
    Some(Observed {
        obs: Obs {
            ai_flag: advice.ai_flag,
            ai_conf: advice.ai_conf,
            ..obs
        },
        ai_ref: advice.ai_ref,
    })
}

fn ask(prompt: &str, key: &str, send: &mut impl FnMut(&Call) -> Option<Vec<u8>>) -> Option<Advice> {
    let titles = FEEDS.iter().find_map(|&(host, path)| {
        let feed = send(&Call {
            host,
            path,
            body: None,
            headers: Vec::new(),
        })?;
        read_titles(&feed)
    })?;
    let headlines = titles.join("\n");
    let reply = MODELS.iter().find_map(|model| {
        send(&Call {
            host: CHAT_HOST,
            path: CHAT_PATH,
            body: Some(chat_body(model, prompt, &headlines)),
            headers: chat_headers(key),
        })
    })?;
    read_advice(&reply)
}

/// `x-no-aliasing` keeps the gateway from answering with another model, whose TEE would not
/// have signed the reply.
fn chat_headers(key: &str) -> Vec<(&'static str, String)> {
    vec![
        ("authorization", format!("Bearer {key}")),
        ("x-no-aliasing", "true".to_string()),
    ]
}

/// Non-streaming, so the reply bytes are what the model's TEE signs.
fn chat_body(model: &str, prompt: &str, headlines: &str) -> String {
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": prompt },
            { "role": "user", "content": headlines },
        ],
        "temperature": 0,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "stream": false,
    });
    keep_reasoning_short(model, &mut body);
    body.to_string()
}

/// GLM-5.3 Flash keeps its reasoning to about 20 tokens at `reasoning_effort` "low";
/// switching its thinking off only moves the reasoning into `content`. Qwen turns thinking
/// off through its chat template. (docs.near.ai/cloud/reasoning-models)
fn keep_reasoning_short(model: &str, body: &mut serde_json::Value) {
    if model == MODELS[0] {
        body["reasoning_effort"] = json!("low");
    } else {
        body["chat_template_kwargs"] = json!({ "enable_thinking": false });
    }
}

/// The headlines of a feed. Only the items count: the channel's own title is no news.
pub fn read_titles(feed: &[u8]) -> Option<Vec<String>> {
    let feed = std::str::from_utf8(feed).ok()?;
    let titles: Vec<String> = feed
        .split("<item>")
        .skip(1)
        .filter_map(title_of)
        .take(MAX_TITLES)
        .collect();
    (!titles.is_empty()).then_some(titles)
}

fn title_of(item: &str) -> Option<String> {
    let (_, rest) = item.split_once("<title>")?;
    let (raw, _) = rest.split_once("</title>")?;
    let raw = raw.trim();
    let text = raw
        .strip_prefix("<![CDATA[")
        .and_then(|inner| inner.strip_suffix("]]>"))
        .unwrap_or(raw)
        .trim();
    let title: String = text
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_TITLE_CHARS)
        .collect();
    // A blank title is no headline, and a feed of them should make way for the backup.
    (!title.trim().is_empty()).then_some(title)
}

/// Anything but the exact answer counts as no answer. `resp_sig_hash` is the hash of these
/// reply bytes, the same `response_hash` that the TEE's signature covers.
pub fn read_advice(reply: &[u8]) -> Option<Advice> {
    let chat: Chat = serde_json::from_slice(reply).ok()?;
    let [choice] = chat.choices.as_slice() else {
        return None;
    };
    if choice.finish_reason != FINISHED || !is_chat_id(&chat.id) {
        return None;
    }
    let answer: Answer = serde_json::from_str(choice.message.content.trim()).ok()?;
    if answer.confidence > MAX_CONFIDENCE {
        return None;
    }
    Some(Advice {
        ai_flag: if answer.risk_flag {
            AI_FLAGGED
        } else {
            AI_CLEAR
        },
        ai_conf: answer.confidence,
        ai_ref: AiRef {
            chat_id: chat.id,
            resp_sig_hash: to_hex(&Sha256::digest(reply)),
        },
    })
}

/// The id goes into the Decision, whose reply to the vault has a hard size limit.
fn is_chat_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_CHAT_ID_BYTES
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}
