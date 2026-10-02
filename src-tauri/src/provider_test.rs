use serde_json::Value;

fn validate(status: reqwest::StatusCode, body: &[u8], key: Option<&str>) -> Result<(), String> {
    let parsed = serde_json::from_slice::<Value>(body).ok();
    let api_error = parsed.as_ref().is_some_and(|v| {
        v.get("error").is_some_and(|e| !e.is_null()) || v["type"] == "error" || v["status"] == "failed"
    });
    let text = |value: &Value| value.as_str().is_some_and(|text| !text.trim().is_empty());
    let content_text = |value: &Value| value.as_array().is_some_and(|parts| parts.iter().any(|part| text(&part["text"]) || text(&part["thinking"])));
    // Reasoning models can spend the small test budget on reasoning alone; that still proves key, URL and model work.
    if status.is_success() && !api_error && parsed.as_ref().is_some_and(|v| {
        v["choices"].as_array().is_some_and(|choices| choices.iter().any(|choice| {
            let message = &choice["message"];
            text(&message["content"]) || content_text(&message["content"]) || text(&message["reasoning_content"]) || text(&message["reasoning"])
                // Hidden reasoning: no text returned, but the model produced tokens before hitting the limit.
                || (choice["finish_reason"] == "length" && message["role"] == "assistant"
                    && v["usage"]["completion_tokens"].as_u64().is_some_and(|tokens| tokens > 0))
        }))
            || content_text(&v["content"])
            || (v["type"] == "message" && v["stop_reason"] == "max_tokens" && v["usage"]["output_tokens"].as_u64().is_some_and(|tokens| tokens > 0))
            // A reasoning item (its summary is often empty) shows the model ran.
            || v["output"].as_array().is_some_and(|items| items.iter().any(|item| match item["type"].as_str() {
                Some("message") => content_text(&item["content"]),
                Some("reasoning") => true,
                _ => false,
            }))
    }) { return Ok(()); }
    let mut detail = match parsed {
        Some(v) => serde_json::to_string_pretty(v.get("error").filter(|e| !e.is_null()).unwrap_or(&v)).unwrap_or_default(),
        None => String::from_utf8_lossy(body).into_owned(),
    };
    if let Some(key) = key.map(str::trim).filter(|k| !k.is_empty()) { detail = detail.replace(key, "[REDACTED]"); }
    detail = detail.chars().take(4000).collect();
    if detail.trim().is_empty() { detail = "Empty response body".into(); }
    let summary = if status.is_success() { "Provider returned an API error or invalid model response".into() }
        else { format!("Provider returned HTTP {status}") };
    Err(format!("{summary}\n{detail}"))
}

pub async fn check_response(mut response: reqwest::Response, key: Option<&str>) -> Result<(), String> {
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| format!("Provider returned HTTP {status}\nFailed to read response body (connection interrupted or timed out)."))? {
        let remaining = (256 * 1024usize).saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if chunk.len() > remaining { return Err(format!("Provider returned HTTP {status}\nResponse body exceeds the test limit (256 KiB).")); }
    }
    validate(status, &body, key)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_error_details_and_redacts_key() {
        let error = validate(reqwest::StatusCode::TOO_MANY_REQUESTS, br#"{"error":{"message":"Quota exceeded secret-value","code":"rate_limit"}}"#, Some("secret-value")).unwrap_err();
        assert!(error.contains("429") && error.contains("Quota exceeded") && error.contains("rate_limit"));
        assert!(!error.contains("secret-value"));
    }
    #[test]
    fn rejects_errors_inside_http_success_and_invalid_bodies() {
        for body in [br#"{"error":{"code":522,"message":"timeout"}}"#.as_slice(), b"{}", br#"{"choices":[{"message":{"content":""}}]}"#, br#"{"choices":[{"finish_reason":"length","message":{"role":"assistant","content":""}}],"usage":{"completion_tokens":0}}"#,br#"{"output":[{"type":"message"}]}"#, br#"{"type":"message","content":[],"stop_reason":"max_tokens","usage":{"output_tokens":0}}"#, b"<html>bad gateway</html>", b""] {
            assert!(validate(reqwest::StatusCode::OK, body, None).is_err());
        }
        for body in [br#"{"choices":[{"message":{"content":"OK"}}]}"#.as_slice(), br#"{"content":[{"type":"text","text":"OK"}]}"#, br#"{"output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}"#,
            br#"{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"The user said Say OK."}}]}"#,
            br#"{"choices":[{"message":{"content":null,"reasoning":"Thinking"}}]}"#,
            // GLM / MiMo style: reasoning_content with an empty answer.
            br#"{"model":"glm-4.6","choices":[{"finish_reason":"length","message":{"role":"assistant","content":"","reasoning_content":"Let me answer OK."}}]}"#,
            br#"{"model":"mimo-v2-flash","choices":[{"finish_reason":"length","message":{"role":"assistant","content":null,"reasoning_content":"Say OK."}}]}"#,
            br#"{"choices":[{"finish_reason":"length","message":{"role":"assistant","content":""}}],"usage":{"completion_tokens":16,"completion_tokens_details":{"reasoning_tokens":16}}}"#,
            br#"{"content":[{"type":"thinking","thinking":"Thinking"}],"stop_reason":"max_tokens"}"#,
            br#"{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Thinking"}]}]}"#,
            br#"{"status":"incomplete","output":[{"type":"reasoning","summary":[]}]}"#,
            br#"{"type":"message","role":"assistant","content":[],"stop_reason":"max_tokens","usage":{"output_tokens":16}}"#] {
            assert!(validate(reqwest::StatusCode::OK, body, None).is_ok());
        }
    }
}
