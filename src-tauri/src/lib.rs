mod debug_curl;
mod cost;
mod performance;
mod agents;
mod custom_agents;
mod lifecycle;
mod resilience;
mod ownership;
mod agent_catalog;
mod agent_adapters;
mod fastclaw_adapter;
mod gemini_bridge;
mod config;
mod proxy;
mod traffic;
mod protocol;
mod provider_import;
mod provider_test;
mod router;

use std::sync::Arc;

use anyhow::{anyhow, Context};
use config::{
    AppConfig, ConfigStore, Model, Provider,
    ProviderKind, RoutingPolicy,
};
use proxy::ProxyHandle;
use reqwest::Client;
use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;

#[derive(Clone)]
struct AppState {
    performance: Arc<performance::Runner>,
    store: Arc<ConfigStore>,
    proxy: Arc<Mutex<Option<ProxyHandle>>>,
}

#[derive(Serialize)]
struct ProxyStatus {
    running: bool,
    paused: bool,
    port: u16,
    base_url: String,
}

#[derive(Serialize)]
struct DashboardSnapshot {
    recovery_notice: Option<String>,
    gateway: resilience::Settings,
    health: Vec<resilience::Status>,
    agent_catalogs: std::collections::HashMap<String, Vec<agent_catalog::Entry>>,
    providers: Vec<Provider>,
    models: Vec<Model>,
    routes: Vec<config::RouteRule>,
    policy: RoutingPolicy,
    proxy: ProxyStatus,
    agents: Vec<agents::AgentStatus>,
    events: Vec<config::RouteEvent>,
    install_id: String,
}

async fn snapshot(state: &AppState) -> DashboardSnapshot {
    let mut config = state.store.read();
    for provider in &mut config.providers {
        provider.has_api_key = provider.kind == ProviderKind::Ollama
            || state.store.read_secret(&format!("provider:{}", provider.id)).is_some();
    }
    config.policy.has_autojev_key = state.store.read_secret("autojev-cloud").is_some();
    let running = state.proxy.lock().await.as_ref().is_some_and(|p|p.running());
    let paused = state.proxy.lock().await.as_ref().is_some_and(|p| p.running() && p.paused());
    let detected = detected_agents_with_selection(&config);
    DashboardSnapshot {
        recovery_notice: lifecycle::notice(config.port),
        gateway: config.gateway.clone(),
        health: state.proxy.lock().await.as_ref().map_or_else(Vec::new, |p|p.health.statuses()),
        agent_catalogs: config.agent_catalogs.clone(),
        providers: config.providers,
        models: config.models,
        routes: config.routes,
        policy: config.policy,
        proxy: ProxyStatus {
            running, paused,
            port: config.port,
            base_url: format!("http://127.0.0.1:{}", config.port),
        },
        agents: detected,
        events: config.events,
        install_id: config.install_id,
    }
}

fn detected_agents_with_selection(config: &config::AppConfig) -> Vec<agents::AgentStatus> {
    let mut detected = agents::detect(&config.custom_agents);
    for agent in &mut detected {
        agent.connected = agent.injection.as_ref().map(|i| custom_agents::owned(i, &dirs::home_dir().unwrap_or_default(), config.port)).unwrap_or_else(|| agents::owned_by(&agent.id,config.port));
        if let Some(selected) = agent.route_id.as_ref() {
            if let Some(entry) = config.agent_catalogs.get(&agent.id).and_then(|entries| entries.iter().find(|e| &e.id == selected)) { agent.route_id = Some(entry.binding.clone()); }
        }
        if agent.route_id.is_none() {
            agent.route_id = config.agent_selections.get(&agent.id).cloned();
        }
    }
    detected
}

#[tauri::command]
async fn get_request_logs(state: State<'_, AppState>, since: String) -> Result<Vec<traffic::RequestLog>, String> {
    let since = chrono::DateTime::parse_from_rfc3339(&since).map_err(|_| "Invalid start date")?
        .with_timezone(&chrono::Utc).to_rfc3339();
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Vec<traffic::RequestLog>> {
        let mut logs=store.request_logs(&since)?;
        let config=store.read();
        for log in &mut logs {
            let requested=log.requested_model.clone();
            traffic::resolve_requested_model(log,&config,&requested);
        }
        Ok(logs)
    })
        .await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())
}

#[tauri::command]
async fn get_model_performance(state: State<'_, AppState>) -> Result<performance::View,String> {
    Ok(state.performance.view(&state.store.read()))
}
#[tauri::command]
async fn start_model_speed_tests(state: State<'_, AppState>, ids: Vec<String>) -> Result<(),String> {
    state.performance.start(state.store.clone(),ids).map_err(|e|e.to_string())
}
#[tauri::command]
async fn cancel_model_speed_tests(state: State<'_, AppState>) -> Result<(),String> {
    state.performance.cancel(); Ok(())
}
#[tauri::command]
async fn save_performance_settings(state: State<'_, AppState>, mut settings: performance::Settings) -> Result<(),String> {
    if !(5..=120).contains(&settings.interval_minutes) {return Err("Test interval must be between 5 and 120 minutes".into());}
    settings.version = 1;
    state.store.update(|c|c.performance_settings=settings).map_err(|e|e.to_string())
}

#[tauri::command]
async fn get_snapshot(state: State<'_, AppState>) -> Result<DashboardSnapshot, String> {
    Ok(snapshot(&state).await)
}

#[tauri::command]
async fn save_provider(
    state: State<'_, AppState>,
    mut provider: Provider,
    api_key: Option<String>,
    add_test_model: Option<bool>,
    original_id: Option<String>,
    creating: Option<bool>,
) -> Result<DashboardSnapshot, String> {
    provider.id = provider.id.trim().to_owned();
    validate_provider(&provider).map_err(|error| error.to_string())?;
    provider.has_api_key = false;
    let old_id = original_id.as_deref().unwrap_or(&provider.id).to_owned();
    let old_account = format!("provider:{old_id}");
    let new_account = format!("provider:{}", provider.id);
    state.store.update_checked(|config| apply_provider_edit(config, provider, original_id.as_deref(), creating.unwrap_or(false), add_test_model.unwrap_or(false)), Some((&old_account, &new_account, api_key.as_deref().map(str::trim).filter(|key|!key.is_empty())))).map_err(|e|e.to_string())?;
    Ok(snapshot(&state).await)
}

fn apply_provider_edit(config: &mut AppConfig, provider: Provider, original_id: Option<&str>, creating: bool, add_test_model: bool) -> anyhow::Result<()> {
    let old_id = original_id.unwrap_or(&provider.id).to_owned();

    if original_id.is_some() && !config.providers.iter().any(|p|p.id==old_id) { return Err(anyhow!("Provider no longer exists")); }
    if (creating || old_id != provider.id) && config.providers.iter().any(|p|p.id==provider.id) { return Err(anyhow!("Provider ID already exists")); }
    for model in &mut config.models { if model.provider_id==old_id { model.provider_id=provider.id.clone(); } }
    if add_test_model { add_provider_test_model(config, &provider); }
    if let Some(existing)=config.providers.iter_mut().find(|p|p.id==old_id) { *existing=provider; } else { config.providers.push(provider); }
    Ok(())
}

fn add_provider_test_model(config: &mut config::AppConfig, provider: &Provider) {
    let model_id = provider.test_model.trim();
    if model_id.is_empty() || config.models.iter().any(|m| m.provider_id == provider.id && m.model_id == model_id) { return; }
    config.models.push(config::Model { input_price_known: Some(false), output_price_known: Some(false), cache_price_known: Some(false),
        id: uuid::Uuid::new_v4().to_string(), provider_id: provider.id.clone(),
        model_id: model_id.into(), name: model_id.into(), api_type: provider.api_type.clone(),
        tier: config::ModelTier::Balanced, enabled: true,
        supports_tools: true, supports_vision: false, supports_reasoning: false,
        context_window: 1000000, input_cost_per_million: 0.0,
        output_cost_per_million: 0.0, cache_cost_per_million: 0.0,
    });
}

#[derive(Serialize)]
struct ImportResult { snapshot: DashboardSnapshot, imported: usize, skipped: usize }

#[tauri::command]
async fn import_providers(state: State<'_, AppState>, source: String) -> Result<ImportResult, String> {
    let (candidates, mut skipped) = tauri::async_runtime::spawn_blocking(move || provider_import::read(&source))
        .await.map_err(|_| "Could not read import source".to_string())?
        .map_err(|error| error.to_string())?;
    let mut imported = 0;
    for item in candidates {
        if provider_import::already_imported(&state.store.read().providers, &item.provider) {
            skipped += 1;
            continue;
        }
        if !item.key.is_empty() {
            state.store.write_secret(&format!("provider:{}", item.provider.id), &item.key)
                .map_err(|_| format!("Could not store credentials. {imported} providers imported before this error."))?;
        }
        let id = item.provider.id.clone();
        if state.store.update(|config| config.providers.push(item.provider)).is_err() {
            let _ = state.store.delete_secret(&format!("provider:{id}"));
            return Err(format!("Could not save provider. {imported} providers imported before this error."));
        }
        imported += 1;
    }
    Ok(ImportResult { snapshot: snapshot(&state).await, imported, skipped })
}

#[tauri::command]
async fn delete_provider(
    state: State<'_, AppState>,
    id: String,
) -> Result<DashboardSnapshot, String> {
    state
        .store
        .update(|config| {
            config.providers.retain(|provider| provider.id != id);
            config.models.retain(|model| model.provider_id != id);
        })
        .map_err(|error| error.to_string())?;
    state.store.delete_secret(&format!("provider:{id}")).map_err(|error| error.to_string())?;
    Ok(snapshot(&state).await)
}

#[tauri::command]
async fn save_route(state: State<'_, AppState>, mut route: config::RouteRule, creating: bool, api_key: Option<String>, original_id: Option<String>) -> Result<DashboardSnapshot, String> {
    route.id=route.id.trim().to_owned();
    state.store.update_checked(|config| apply_route_edit(config, route, original_id.as_deref(), creating), None).map_err(|e| e.to_string())?;
    if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
        state.store.write_secret("autojev-cloud", key.trim()).map_err(|e| e.to_string())?;
    }
    Ok(snapshot(&state).await)
}

fn apply_route_edit(config: &mut AppConfig, mut route: config::RouteRule, original_id: Option<&str>, creating: bool) -> anyhow::Result<()> {

    route.model_ids.retain(|id| config.models.iter().any(|m| &m.id == id));
    route.model_settings.retain(|id,_| route.model_ids.contains(id));
    router::validate_rule(config, &route)?;
    let old_id=original_id.unwrap_or(&route.id);
    if original_id.is_some() && !config.routes.iter().any(|r|r.id==old_id) { return Err(anyhow!("Route no longer exists")); }
    if (creating || old_id != route.id) && config.routes.iter().any(|r| r.id == route.id) {
        return Err(anyhow!("Route ID already exists"));
    }
    for binding in config.agent_selections.values_mut() { if binding==old_id { *binding=route.id.clone(); } }
    for entries in config.agent_catalogs.values_mut() { for entry in entries { if entry.binding==old_id { entry.binding=route.id.clone(); } } }
    if let Some(existing) = config.routes.iter_mut().find(|r| r.id == old_id) {
        *existing = route;
    } else { config.routes.push(route); }
    Ok(())
}

#[tauri::command]
async fn delete_route(state: State<'_, AppState>, id: String) -> Result<DashboardSnapshot, String> {
    state.store.update(|config| config.routes.retain(|r| r.id != id)).map_err(|e| e.to_string())?;
    Ok(snapshot(&state).await)
}

#[tauri::command]
async fn save_model(state: State<'_, AppState>, mut model: Model) -> Result<DashboardSnapshot, String> {
    model.supports_tools = true;
    model.model_id = model.model_id.trim().to_owned();
    state.store.update(|config| -> anyhow::Result<()> {
        validate_model(config, &model)?;
        if let Some(existing) = config.models.iter_mut().find(|item| item.id == model.id) {
            *existing = model;
        } else { config.models.push(model); }
        Ok(())
    }).map_err(|error| error.to_string())?.map_err(|error| error.to_string())?;
    Ok(snapshot(&state).await)
}

#[tauri::command]
async fn delete_model(state: State<'_, AppState>, id: String) -> Result<DashboardSnapshot, String> {
    state
        .store
        .update(|config| {
            config.models.retain(|model| model.id != id);
            for route in &mut config.routes {
                route.model_ids.retain(|candidate| candidate != &id);
                route.model_settings.remove(&id);
                if let Some(policy) = &mut route.automatic_policy {
                    if policy.savings_baseline_model_id.as_deref() == Some(&id) { policy.savings_baseline_model_id = None; }
                }
            }
            if config.policy.savings_baseline_model_id.as_deref() == Some(&id) {
                config.policy.savings_baseline_model_id = None;
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(snapshot(&state).await)
}

fn validate_jev_policy(policy:&RoutingPolicy)->Result<(),String>{
    let url=reqwest::Url::parse(&policy.jev_endpoint).map_err(|_|"Invalid Jev endpoint")?;
    if !(url.scheme()=="https" || (url.scheme()=="http" && matches!(url.host_str(),Some("127.0.0.1"|"localhost"|"[::1]")))) || !url.username().is_empty() || url.password().is_some() {return Err("Jev endpoint must use HTTPS or loopback HTTP without embedded credentials".into());}
    Ok(())
}
#[tauri::command]
async fn test_jev_settings(state:State<'_,AppState>,policy:RoutingPolicy,api_key:Option<String>)->Result<String,String>{
    validate_jev_policy(&policy)?;
    let key=api_key.filter(|s|!s.trim().is_empty()).or_else(||state.store.read_secret("autojev-cloud")).ok_or("Enter a Jev access key")?;
    let mut config=state.store.read();config.policy=policy;
    let client=config.gateway.client().map_err(|e|e.to_string())?;
    router::probe_jev(&config,&client,key.trim()).await.map_err(|_|"Jev test failed: check the endpoint, model ID, credentials and returned candidate ID".into())
}

#[tauri::command]
async fn save_policy(
    state: State<'_, AppState>,
    mut policy: RoutingPolicy,
    autojev_key: Option<String>,
) -> Result<DashboardSnapshot, String> {
    validate_jev_policy(&policy)?;
    policy.jev_model=policy.jev_model.trim().to_owned();
    policy.has_autojev_key = false;
    if let Some(key) = autojev_key.filter(|value| !value.trim().is_empty()) {
        state.store.write_secret("autojev-cloud", key.trim()).map_err(|error| error.to_string())?;
    }
    state
        .store
        .update(|config| config.policy = policy)
        .map_err(|error| error.to_string())?;
    Ok(snapshot(&state).await)
}

async fn safe_stop(state:&AppState)->Result<(),String> {
    let mut handle=state.proxy.lock().await;
    agents::restore_gateway(state.store.read().port).map_err(|e|e.to_string())?;
    if let Some(proxy)=handle.take(){proxy.stop().await;}Ok(())
}
#[tauri::command]
async fn save_gateway_settings(state:State<'_,AppState>,gateway:resilience::Settings)->Result<DashboardSnapshot,String> {
    gateway.validate().map_err(|e|e.to_string())?;
    let service=state.proxy.lock().await;
    let old=state.store.read().gateway;
    if service.is_some() && (old.proxy_mode!=gateway.proxy_mode || old.proxy_url!=gateway.proxy_url || old.connect_timeout_seconds!=gateway.connect_timeout_seconds) {return Err("Stop the gateway before changing outbound proxy or connection timeout".into());}
    state.store.update(|c|c.gateway=gateway).map_err(|e|e.to_string())?;
    drop(service);
    Ok(snapshot(&state).await)
}
#[tauri::command]
async fn get_gateway_health(state:State<'_,AppState>)->Result<Vec<resilience::Status>,String>{
    let handle=state.proxy.lock().await;let mut result=handle.as_ref().map_or_else(Vec::new,|p|p.health.statuses());result.sort_by(|a,b|a.model_id.cmp(&b.model_id));Ok(result)
}
#[tauri::command]
async fn reset_gateway_health(state:State<'_,AppState>, model_id: Option<String>)->Result<DashboardSnapshot,String>{
    if let Some(p)=state.proxy.lock().await.as_ref(){if let Some(id)=model_id { p.health.reset_model(&id); } else { p.health.reset(); }}Ok(snapshot(&state).await)
}

#[tauri::command]
async fn start_proxy(state: State<'_, AppState>) -> Result<DashboardSnapshot, String> {
    let mut handle = state.proxy.lock().await;
    let starting = !handle.as_ref().is_some_and(|p|p.running());
    if starting {
        *handle = Some(
            proxy::start(state.store.clone())
                .await
                .map_err(|error| error.to_string())?,
        );
    }
    if let Some(proxy) = handle.as_ref() { proxy.set_paused(false); }
    if starting { reconnect_saved_agents(&state.store).map_err(|error| error.to_string())?; }
    drop(handle);
    Ok(snapshot(&state).await)
}

#[tauri::command]
async fn pause_proxy(state: State<'_, AppState>) -> Result<DashboardSnapshot, String> {
    let handle = state.proxy.lock().await;
    let proxy = handle.as_ref().filter(|p| p.running()).ok_or("Start the local proxy before pausing")?;
    proxy.set_paused(true);
    drop(handle);
    Ok(snapshot(&state).await)
}

#[tauri::command]
async fn stop_proxy(state: State<'_, AppState>) -> Result<DashboardSnapshot, String> {
    safe_stop(&state).await?;
    Ok(snapshot(&state).await)
}

#[tauri::command]
async fn preview_route(
    state: State<'_, AppState>,
    input: router::RoutePreviewInput,
) -> Result<router::RouteDecision, String> {
    let client = Client::new();
    let mut config = state.store.read();
    config.install_id = format!("preview:{}", config.install_id);
    if cost::is_cost_route(&config, &input) {
        let store=state.store.clone();
        config.cost_history=tauri::async_runtime::spawn_blocking(move || store.recent_cost_logs().unwrap_or_default()).await.unwrap_or_default();
    }
    router::decide(&config, &input, &client, state.store.read_secret("autojev-cloud").as_deref())
        .await
        .map(|route| route.decision)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn debug_request(state: State<'_, AppState>, target: String, endpoint: String, prompt: serde_json::Value, history: Option<Vec<serde_json::Value>>, parameters: Option<serde_json::Value>, session_id: Option<String>, on_progress: tauri::ipc::Channel<serde_json::Value>) -> Result<serde_json::Value, String> {
    if !target.starts_with("autojev/") || (!prompt.is_string() && !prompt.is_array()) || prompt.as_str().is_some_and(|text| text.trim().is_empty() || text.len() > 32000) || prompt.as_array().is_some_and(|parts| parts.is_empty()) { return Err("Select a target and enter a prompt (maximum 32,000 bytes)".into()); }
    if !matches!(endpoint.as_str(), "chat/completions" | "messages" | "responses") { return Err("Invalid API format".into()); }
    if state.proxy.lock().await.is_none() { return Err("Start the local proxy before testing".into()); }
    let mut messages = history.unwrap_or_default();
    if messages.len() > 100 || messages.iter().any(|m| !matches!(m["role"].as_str(), Some("user" | "assistant")) || (!m["content"].is_string() && !m["content"].is_array())) || serde_json::to_vec(&messages).map_err(|e|e.to_string())?.len() > 24 * 1024 * 1024 { return Err("Invalid debug conversation".into()); }
    messages.push(serde_json::json!({"role":"user","content":prompt}));
    if serde_json::to_vec(&messages).map_err(|e| e.to_string())?.len() > 24 * 1024 * 1024 { return Err("Debug conversation exceeds 24 MB".into()); }
    let mut body = if endpoint == "responses" { serde_json::json!({"model": target, "input": messages}) }
        else { serde_json::json!({"model": target, "messages": messages}) };
    if let Some(params) = parameters {
        let params = params.as_object().ok_or("Parameters must be an object")?;
        for (key, value) in params {
            let target_key = if key == "max_tokens" && endpoint == "responses" { "max_output_tokens" } else if key == "max_output_tokens" && endpoint != "responses" { "max_tokens" } else { key };
            body[target_key] = value.clone();
        }
    }
    let start = std::time::Instant::now();
    let mut response = Client::builder().timeout(std::time::Duration::from_secs(90)).build().map_err(|e|e.to_string())?
        .post(format!("http://127.0.0.1:{}/v1/{endpoint}", state.store.read().port))
        .header("x-autojev-session-id", session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()))
        .header("user-agent", "AutoJev/Debug")
        .header("anthropic-version", "2023-06-01").json(&body).send().await.map_err(|_| "Debug request failed or timed out".to_string())?;
    let is_sse = response.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("text/event-stream"));
    let status = response.status().as_u16();
    let request_id = response.headers().get("x-autojev-request-id").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let model = response.headers().get("x-autojev-model").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let source = response.headers().get("x-autojev-route-source").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let mut bytes = Vec::new();
    let mut progress = protocol::DebugProgress::default();
    let format = protocol::Protocol::parse(&endpoint).map_err(|e| e.to_string())?;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 1024 * 1024 { return Err("Debug response exceeds 1 MB".into()); }
        if is_sse {
            if let Ok(events) = progress.push(&chunk, format) {
                for event in events { let _ = on_progress.send(event); }
            }
        }
        bytes.extend_from_slice(&chunk);
    }
    let elapsed_ms = start.elapsed().as_millis();
    let parsed_body = if is_sse { Some(protocol::collect_debug_stream(&bytes, protocol::Protocol::parse(&endpoint).map_err(|e| e.to_string())?, &target).map_err(|e| e.to_string())?) } else { None };
    // Correlate the completed request, never the latest global log (other agents
    // may be using the gateway concurrently). Telemetry must not fail the reply.
    let store = state.store.clone();
    let telemetry = tauri::async_runtime::spawn_blocking(move || {
        if request_id.is_empty() { return None; }
        for _ in 0..5 {
            if let Ok(Some(log)) = store.request_log(&request_id) { return Some(log); }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        None
    }).await.unwrap_or(None);
    Ok(serde_json::json!({"status":status,"model":model,"source":source,"elapsed_ms":elapsed_ms,"body":String::from_utf8_lossy(&bytes),"telemetry":telemetry,"request_body":body,"parsed_body":parsed_body}))
}

#[tauri::command]
async fn test_custom_agent(agent: agents::CustomAgent) -> Result<String, String> {
    agents::test_custom(agent).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_custom_agent(state: State<'_, AppState>, mut agent: agents::CustomAgent) -> Result<DashboardSnapshot, String> {
    agent.name = agent.name.trim().to_owned();
    agent.command = agent.command.trim().to_owned();
    let home = dirs::home_dir().ok_or("Cannot locate home directory")?;
    let requested_path = agent.config_path.as_deref().or_else(|| agent.injection.as_ref().map(|i| i.path.as_str())).unwrap_or("").to_owned();
    agent.injection = custom_agents::infer(&agent.command, &requested_path, &home).map_err(|e| e.to_string())?;
    agent.config_path = Some(agent.injection.as_ref().map(|i| i.path.clone()).unwrap_or_else(|| requested_path.trim().to_owned()));
    agents::validate_custom(&agent).map_err(|e| e.to_string())?;
    let lock = ownership::config_lock(&home).map_err(|e| e.to_string())?;
    let config = state.store.read();
    if let Some(old) = config.custom_agents.iter().find(|a| a.id == agent.id).and_then(|a| a.injection.as_ref()) {
        if ownership::owner(&old.resolve(&home).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?.is_some() {
            return Err("Disconnect the agent before editing its configuration".into());
        }
    }
    if let Some(injection) = &agent.injection {
        let path = injection.resolve(&home).map_err(|e| e.to_string())?;
        let duplicate = config.custom_agents.iter().filter(|a| a.id != agent.id).filter_map(|a| a.injection.as_ref()).any(|i| i.resolve(&home).ok().as_ref() == Some(&path));
        let builtin = ["codex", "claude", "gemini", "grok", "kimi", "openclaw", "opencode", "hermes", "omp", "fastclaw", "cursor"].into_iter().flat_map(agents::configuration_paths).any(|p| p.canonicalize().unwrap_or(p) == path);
        if duplicate || builtin { return Err("Configuration path is already managed by another agent".into()); }
    }
    state.store.update(|config| {
        config.custom_agents.retain(|a| a.id != agent.id);
        config.custom_agents.push(agent);
    }).map_err(|e| e.to_string())?;
    drop(lock);
    Ok(snapshot(&state).await)
}

#[tauri::command]
async fn launch_agent(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let custom = state.store.read().custom_agents;
    tauri::async_runtime::spawn_blocking(move || agents::launch(&id, &custom))
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_agent_config(app: tauri::AppHandle, state: State<'_, AppState>, id: String, index: usize) -> Result<(), String> {
    if !agents::detect(&state.store.read().custom_agents).iter().any(|agent| agent.id == id) { return Err("Unknown agent".into()); }
    let custom = state.store.read().custom_agents;
    let paths = if let Some(injection) = custom.iter().find(|a| a.id == id).and_then(|a| a.injection.as_ref()) {
        vec![injection.resolve(&dirs::home_dir().unwrap_or_default()).map_err(|e| e.to_string())?]
    } else { agents::configuration_paths(&id) };
    let path = paths.get(index).cloned().ok_or("Configuration file is unavailable")?;
    if !path.is_file() { return Err("Configuration file does not exist yet".into()); }
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        if path.extension().is_some_and(|ext| ext == "db") {
            return app.opener().reveal_item_in_dir(&path).map_err(|e|e.to_string());
        }
        #[cfg(target_os = "macos")]
        {
            let status = std::process::Command::new("/usr/bin/open").arg("-t").arg(&path).status().map_err(|e|e.to_string())?;
            if status.success() { Ok(()) } else { Err("Could not open configuration file".into()) }
        }
        #[cfg(not(target_os = "macos"))]
        { app.opener().open_path(path.to_string_lossy().into_owned(), None::<&str>).map_err(|e|e.to_string()) }
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
async fn detect_agents(state: State<'_, AppState>) -> Result<Vec<agents::AgentStatus>, String> {
    let config = state.store.read();
    tauri::async_runtime::spawn_blocking(move || detected_agents_with_selection(&config)).await.map_err(|e| e.to_string())
}

fn inject_agent(custom: &[agents::CustomAgent], id: &str, port: u16, binding: &str, catalog: &[agent_catalog::Entry]) -> anyhow::Result<()> {
    if let Some(agent) = custom.iter().find(|agent| agent.id == id) {
        let injection = agent.injection.as_ref().context("Custom agent requires manual configuration")?;
        let public = &catalog.iter().find(|entry| entry.binding == binding).context("Default model must be selected")?.id;
        return custom_agents::connect(injection, &dirs::home_dir().context("Cannot locate home directory")?, port, public, id);
    }
    let api = if id == "claude" { "messages" } else if id == "codex" { "responses" } else { "chat_completions" };
    if id == "codex" {
        agents::connect_codex_catalog(port, binding, catalog, &dirs::home_dir().context("Cannot locate home directory")?)
    } else if id == "claude" {
        agents::connect_claude_catalog(port, binding, catalog, &dirs::home_dir().context("Cannot locate home directory")?)
    } else if agent_catalog::supported(id) {
        agent_adapters::connect_catalog(id, port, binding, api, &dirs::home_dir().unwrap_or_default(), catalog)
    } else {
        let public = &catalog.iter().find(|entry| entry.binding == binding).context("Default model must be selected")?.id;
        agents::connect(id, port, public, api)
    }
}

fn reconnect_saved_agents(store: &ConfigStore) -> anyhow::Result<()> {
    let _lock = ownership::config_lock(&dirs::home_dir().context("Cannot locate home directory")?)?;
    agents::repair_orphan_models(&dirs::home_dir().context("Cannot locate home directory")?)?;
    let config = store.read();
    let mut errors = Vec::new();
    for (id, binding) in agent_catalog::reconnect_targets(&config) {
        let result = (|| -> anyhow::Result<()> {
            // Existing saved bindings predate the explicit auto-connect preference.
            let bindings = config.agent_catalogs.get(id).filter(|items| !items.is_empty())
                .map(|items| items.iter().map(|entry| entry.binding.clone()).collect::<Vec<_>>())
                .unwrap_or_else(|| vec![binding.to_owned()]);
            if !bindings.iter().any(|value| value == binding) { return Err(anyhow!("Default model must be selected")); }
            let catalog = agent_catalog::build(&config, &bindings)?;
            inject_agent(&config.custom_agents, id, config.port, binding, &catalog)?;
            store.update(|config| { config.agent_auto_connect.insert(id.to_owned(), true); config.agent_catalogs.insert(id.to_owned(), catalog); })?;
            Ok(())
        })();
        if let Err(error) = result { errors.push(format!("{id}: {error}")); }
    }
    if errors.is_empty() { Ok(()) } else { Err(anyhow!("Could not reconnect agents:\n{}", errors.join("\n"))) }
}

#[tauri::command]
async fn connect_agent(
    state: State<'_, AppState>,
    id: String,
    route_id: String,
    route_ids: Option<Vec<String>>,
    only_connected: Option<bool>,
) -> Result<DashboardSnapshot, String> {
    let config = state.store.read();
    let bindings = route_ids.unwrap_or_else(|| vec![route_id.clone()]);
    if !bindings.contains(&route_id) { return Err("Default model must be selected".into()); }
    let catalog = agent_catalog::build(&config, &bindings).map_err(|e| e.to_string())?;
    if let Some(model_id) = route_id.strip_prefix("model/") {
        if !config.models.iter().any(|m| m.id == model_id && m.enabled
            && config.providers.iter().any(|p| p.id == m.provider_id && p.enabled)) {
            return Err("Model is unavailable".into());
        }
    } else {
        let route = config.routes.iter().find(|r| r.id == route_id && r.enabled)
            .ok_or("Route is unavailable")?;
        router::validate_available_rule(&config, route).map_err(|e| e.to_string())?;
    }
    let candidates: Vec<_> = if let Some(model_id) = route_id.strip_prefix("model/") {
        config.models.iter().filter(|m| m.id == model_id).collect()
    } else {
        let route = config.routes.iter().find(|r| r.id == route_id).ok_or("Route is unavailable")?;
        config.models.iter().filter(|m| route.includes_model(&m.id)).collect()
    };
    let has_candidate = candidates.iter().filter(|m| m.enabled).any(|model| {
        config.providers.iter().any(|provider| provider.id == model.provider_id && provider.enabled
            && protocol::Protocol::upstream(model, provider).is_ok())
    });
    if !has_candidate { return Err("No compatible enabled candidate for this route".into()); }
    let mut service=state.proxy.lock().await;
    let config_lock=ownership::config_lock(&dirs::home_dir().unwrap_or_default()).map_err(|e|e.to_string())?;
    if only_connected.unwrap_or(false) {
        let current = state.store.read();
        if current.agent_auto_connect.get(&id) == Some(&false)
            || !detected_agents_with_selection(&current).iter().any(|agent| agent.id == id && agent.connected) {
            return Err("Agent disconnected; configuration update skipped.".into());
        }
    } else if !service.as_ref().is_some_and(|p|p.running()) {
        *service=Some(proxy::start(state.store.clone()).await.map_err(|e|e.to_string())?);
    }
    inject_agent(&config.custom_agents, &id, config.port, &route_id, &catalog).map_err(|error| error.to_string())?;
    state.store.update(|config| { config.agent_selections.insert(id.clone(), route_id.clone()); config.agent_catalogs.insert(id.clone(), catalog); config.agent_auto_connect.insert(id.clone(), true); }).map_err(|e| e.to_string())?;
    drop(config_lock);
    drop(service);
    Ok(snapshot(&state).await)
}

#[tauri::command]
async fn restore_agent(
    state: State<'_, AppState>,
    id: String,
) -> Result<DashboardSnapshot, String> {
    let service=state.proxy.lock().await;
    let config_lock=ownership::config_lock(&dirs::home_dir().unwrap_or_default()).map_err(|e|e.to_string())?;
    let config = state.store.read();
    let custom_injection = config.custom_agents.iter().find(|a| a.id == id).and_then(|a| a.injection.as_ref());
    let owned = custom_injection.map(|i| custom_agents::owned(i, &dirs::home_dir().unwrap_or_default(), config.port)).unwrap_or_else(|| agents::owned_by(&id,config.port));
    if !owned {return Err("This agent is not connected to this gateway instance".into());}
    if let Some(binding) = detected_agents_with_selection(&config).into_iter().find(|a| a.id == id).and_then(|a| a.route_id) {
        state.store.update(|config| { config.agent_selections.insert(id.clone(), binding); }).map_err(|e| e.to_string())?;
    }
    if let Some(injection) = custom_injection { custom_agents::restore(injection, &dirs::home_dir().unwrap_or_default(), config.port).map_err(|e| e.to_string())?; }
    else { agents::restore_for_gateway(&id,config.port).map_err(|error| error.to_string())?; }
    state.store.update(|config| { config.agent_auto_connect.insert(id.clone(), false); }).map_err(|e| e.to_string())?;
    drop(config_lock);drop(service);
    Ok(snapshot(&state).await)
}

#[tauri::command]
async fn test_provider_draft(state: State<'_, AppState>, provider: Provider, api_key: Option<String>) -> Result<String, String> {
    validate_provider(&provider).map_err(|e| e.to_string())?;
    if provider.test_model.trim().is_empty() { return Err("Enter a test model".into()); }
    let key = api_key.filter(|k| !k.trim().is_empty()).or_else(|| {
        state.store.read().providers.iter().find(|p| p.id == provider.id)
            .and_then(|_| state.store.read_secret(&format!("provider:{}", provider.id)))
    });
    let responses = match provider.api_type.as_str() {
        "" | "chat_completions" | "messages" => false,
        "responses" => true,
        _ => return Err("Unsupported API type".into()),
    };
    let base = provider.base_url.trim_end_matches('/');
    let messages = provider.api_type == "messages";
    let base = if base.ends_with("/v1") { base.to_string() } else { format!("{base}/v1") };
    let endpoint = if messages { "messages" } else if responses { "responses" } else { "chat/completions" };
    let payload = if responses { serde_json::json!({"model":provider.test_model,"input":"Say OK","max_output_tokens":16,"stream":false}) }
        else { serde_json::json!({"model":provider.test_model,"messages":[{"role":"user","content":"Say OK"}],"max_tokens":16,"stream":false}) };
    let mut request = state.store.read().gateway.client().map_err(|e|e.to_string())?.post(format!("{base}/{endpoint}")).header("user-agent", "AutoJev/ProviderTest").header("HTTP-Referer", "https://autojev.ai").header("X-Title", "AutoJev").timeout(std::time::Duration::from_secs(30)).json(&payload);
    if messages { request = request.header("anthropic-version", "2023-06-01"); }
    if let Some(key) = key.as_ref() { request = if messages { request.header("x-api-key", key.trim()) } else { request.bearer_auth(key.trim()) }; }
    let response = match request.send().await {
        Ok(response) => response,
        Err(_) => {
            return Err("Connection failed or timed out. Check the base URL and network.".into());
        }
    };
    if let Err(error) = provider_test::check_response(response, key.as_deref()).await {
        return Err(error);
    }
    Ok("Test request succeeded.".into())
}

#[tauri::command]
async fn test_provider(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let provider = state.store.read().providers.into_iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| "Provider not found".to_string())?;
    test_provider_draft(state, provider, None).await
}

fn validate_provider(provider: &Provider) -> anyhow::Result<()> {
    if provider.id.trim().is_empty() || provider.name.trim().is_empty() {
        return Err(anyhow!("Provider ID and name are required"));
    }
    if !provider
        .id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(anyhow!(
            "Provider ID may contain only letters, numbers, hyphens and underscores"
        ));
    }
    if !(provider.base_url.starts_with("https://")
        || provider.base_url.starts_with("http://127.0.0.1")
        || provider.base_url.starts_with("http://localhost"))
    {
        return Err(anyhow!("Provider URL must use HTTPS or loopback HTTP"));
    }
    Ok(())
}

fn validate_model(config: &AppConfig, model: &Model) -> anyhow::Result<()> {
    if model.id.trim().is_empty()
        || model.name.trim().is_empty()
        || model.model_id.trim().is_empty()
    {
        return Err(anyhow!("Model ID, provider model ID and name are required"));
    }
    if !config
        .providers
        .iter()
        .any(|provider| provider.id == model.provider_id)
    {
        return Err(anyhow!("Select an existing provider"));
    }
    if config.models.iter().any(|existing| existing.id != model.id
        && existing.provider_id == model.provider_id
        && existing.model_id.trim() == model.model_id.trim()) {
        return Err(anyhow!("This model ID already exists for this provider."));
    }
    if [model.input_cost_per_million, model.output_cost_per_million, model.cache_cost_per_million].iter().any(|cost| !cost.is_finite() || *cost < 0.0) {
        return Err(anyhow!("Model pricing cannot be negative"));
    }
    Ok(())
}

static EXIT_READY: std::sync::atomic::AtomicBool=std::sync::atomic::AtomicBool::new(false);
static EXIT_PENDING: std::sync::atomic::AtomicBool=std::sync::atomic::AtomicBool::new(false);
fn show_main(app:&tauri::AppHandle){
    // The Dock icon only appears while the main window is open; the menu bar icon stays as the entry point.
    #[cfg(target_os="macos")]
    let _=app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.unminimize();let _=w.set_focus();}
}
fn hide_main(window:&tauri::Window){
    let _=window.hide();
    #[cfg(target_os="macos")]
    let _=window.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
}
fn request_safe_exit(app:tauri::AppHandle){
    use std::sync::atomic::Ordering;
    if EXIT_PENDING.swap(true,Ordering::SeqCst){return;}
    tauri::async_runtime::spawn(async move{
        let state=app.state::<AppState>().inner().clone();
        match safe_stop(&state).await {
            Ok(())=>{EXIT_READY.store(true,Ordering::SeqCst);app.exit(0);},
            Err(error)=>{EXIT_PENDING.store(false,Ordering::SeqCst);show_main(&app);let _=app.emit("gateway-lifecycle-error",error);}
        }
    });
}
pub fn run() {
    if lifecycle::watchdog_entry(){return;}
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window,event|{if let tauri::WindowEvent::CloseRequested{api,..}=event{api.prevent_close();hide_main(window);}})
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_decorations(false)?;
                window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))?;
            }
            let root = dirs::home_dir().context("find home directory")?.join(".autojev");
            let database = if app.config().identifier.ends_with(".dev") { "autojev-dev.db" } else { "autojev.db" };
            let store = Arc::new(ConfigStore::open(root.join(database))?);
            let port = if app.config().identifier.ends_with(".dev") { config::DEV_PORT } else { config::DEFAULT_PORT };
            app.manage(lifecycle::lock(port)?);
            lifecycle::spawn_watchdog(port)?;
            if store.read().port != port { store.update(|config| config.port = port)?; }
            let state = AppState {
                performance: Arc::new(performance::Runner::default()),
                store: store.clone(),
                proxy: Arc::new(Mutex::new(None)),
            };
            tauri::async_runtime::spawn(performance::schedule(state.store.clone(),state.performance.clone()));
            let proxy_state = state.clone();
            let startup_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut service=proxy_state.proxy.lock().await;
                if service.is_some(){return;}
                match proxy::start(store).await {
                    Ok(handle) => {
                        *service = Some(handle);
                        if let Err(error) = reconnect_saved_agents(&proxy_state.store) {
                            eprintln!("AutoJev agent reconnection: {error}");
                            let _ = startup_app.emit("gateway-lifecycle-error", error.to_string());
                        }
                    },
                    Err(error) => eprintln!("AutoJev proxy did not start automatically: {error}"),
                }
            });
            app.manage(state);
            let show=tauri::menu::MenuItem::with_id(app,"show","Open AutoJev",true,None::<&str>)?;
            let quit=tauri::menu::MenuItem::with_id(app,"safe-quit","Quit AutoJev (restore agents)",true,None::<&str>)?;
            let menu=tauri::menu::Menu::with_items(app,&[&show,&quit])?;
            let mut tray=tauri::tray::TrayIconBuilder::new().tooltip("AutoJev").menu(&menu).on_menu_event(|app,event|match event.id.as_ref(){"show"=>show_main(app),"safe-quit"=>request_safe_exit(app.clone()),_=>{}})
                // Left click opens the app; right click shows the menu.
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray,event|{if let tauri::tray::TrayIconEvent::Click{button:tauri::tray::MouseButton::Left,button_state:tauri::tray::MouseButtonState::Up,..}=event{show_main(tray.app_handle());}});
            #[cfg(target_os = "macos")]
            {
                tray = tray.icon(tauri::include_image!("icons-tray/44x44.png")).icon_as_template(true);
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(icon)=app.default_window_icon(){tray=tray.icon(icon.clone());}
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_model_performance,
            start_model_speed_tests,
            cancel_model_speed_tests,
            save_performance_settings,
            get_request_logs,
            save_provider,
            import_providers,
            delete_provider,
            save_model,
            save_route,
            delete_route,
            delete_model,
            save_policy,
            test_jev_settings,
            save_gateway_settings,
            reset_gateway_health,
            get_gateway_health,
            start_proxy,
            stop_proxy,
            pause_proxy,
            preview_route,
            debug_request,
            debug_curl::debug_curl,
            debug_curl::cancel_debug_curl,
            detect_agents,
            open_agent_config,
            launch_agent,
            save_custom_agent,
            test_custom_agent,
            connect_agent,
            restore_agent,
            test_provider,
            test_provider_draft
        ])
        .build(tauri::generate_context!())
        .expect("error while building AutoJev")
        .run(|app,event|{match event{
            tauri::RunEvent::ExitRequested{api,code,..} if code!=Some(tauri::RESTART_EXIT_CODE) && !EXIT_READY.load(std::sync::atomic::Ordering::SeqCst)=>{api.prevent_exit();request_safe_exit(app.clone());},
            #[cfg(target_os="macos")]
            tauri::RunEvent::Reopen{..}=>show_main(app),
            _=>{}
        }});
}

#[cfg(test)]
mod model_uniqueness_tests {
    use super::*;
    #[test]
    fn model_id_is_unique_within_each_provider() {
        let config = AppConfig::default();
        let mut model = config.models[0].clone();
        assert!(validate_model(&config, &model).is_ok());
        model.id = "new-id".into();
        model.model_id = format!(" {} ", model.model_id);
        assert!(validate_model(&config, &model).is_err());
        model.provider_id = config.providers[1].id.clone();
        assert!(validate_model(&config, &model).is_ok());
    }
}

#[cfg(test)]
mod provider_model_tests {
    #[test]
    fn tested_model_is_enabled_and_deduplicated_per_provider() {
        let mut config = crate::config::AppConfig::default();
        let mut provider = config.providers[0].clone();
        provider.test_model = "  tested-model  ".into();
        super::add_provider_test_model(&mut config, &provider);
        super::add_provider_test_model(&mut config, &provider);
        let models: Vec<_> = config.models.iter().filter(|m| m.model_id == "tested-model").collect();
        assert_eq!(models.len(), 1);
        assert!(models[0].enabled);
        assert_eq!(models[0].api_type, provider.api_type);
        provider.id = "another-provider".into();
        super::add_provider_test_model(&mut config, &provider);
        assert_eq!(config.models.iter().filter(|m| m.model_id == "tested-model").count(), 2);
    }
}

#[cfg(test)]
mod identifier_edit_tests {
    use super::*;
    #[test]
    fn provider_rename_preserves_model_references_and_rejects_conflicts() {
        let mut config=AppConfig::default();
        let mut provider=config.providers[0].clone();
        let old=provider.id.clone();
        provider.id="renamed-provider".into();
        apply_provider_edit(&mut config,provider.clone(),Some(&old),false,false).unwrap();
        assert!(!config.providers.iter().any(|p|p.id==old));
        assert!(!config.models.iter().any(|m|m.provider_id==old));
        assert!(config.models.iter().any(|m|m.provider_id==provider.id));
        let before=serde_json::to_value(&config).unwrap();
        assert!(apply_provider_edit(&mut config,provider.clone(),None,true,false).is_err());
        assert_eq!(serde_json::to_value(&config).unwrap(),before);
        provider.id=config.providers[1].id.clone();
        assert!(apply_provider_edit(&mut config,provider,Some("renamed-provider"),false,false).is_err());
        assert_eq!(serde_json::to_value(&config).unwrap(),before);
    }
    #[test]
    fn route_rename_updates_bindings_without_replacing_other_routes() {
        let mut config=AppConfig::default();
        let route=config::RouteRule {id:"old".into(),name:"Route".into(),strategy:"jev".into(),all_models:true,enabled:true,model_ids:vec![],model_settings:Default::default(),automatic_policy:None};
        config.routes=vec![route.clone()];
        config.agent_selections.insert("agent".into(),"old".into());
        config.agent_catalogs.insert("agent".into(),vec![crate::agent_catalog::Entry {id:"autojev/old".into(),name:"Route".into(),binding:"old".into()}]);
        let mut renamed=route; renamed.id="new".into();
        apply_route_edit(&mut config,renamed.clone(),Some("old"),false).unwrap();
        assert_eq!(config.routes.len(),1);
        assert_eq!(config.agent_selections["agent"],"new");
        assert_eq!(config.agent_catalogs["agent"][0].binding,"new");
        assert_eq!(config.agent_catalogs["agent"][0].id,"autojev/old");
        assert!(apply_route_edit(&mut config,renamed,None,true).is_err());
    }
}
