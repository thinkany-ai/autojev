use std::{fs, path::PathBuf, sync::RwLock};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use rusqlite::{Connection, OptionalExtension};
use uuid::Uuid;

fn default_tools() -> bool { true }

pub const DEFAULT_PORT: u16 = 9527;
pub const DEV_PORT: u16 = 9526;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Provider {
    #[serde(default)]
    pub preset: String,
    #[serde(default)]
    pub api_type: String,
    #[serde(default)]
    pub test_model: String,
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub enabled: bool,
    #[serde(default)]
    pub has_api_key: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Openrouter,
    Ollama,
    OpenaiCompatible,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Model {
    #[serde(default)]
    pub input_price_known: Option<bool>,
    #[serde(default)]
    pub output_price_known: Option<bool>,
    #[serde(default)]
    pub cache_price_known: Option<bool>,
    #[serde(default)]
    pub api_type: String,
    #[serde(default)]
    pub cache_cost_per_million: f64,
    pub id: String,
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
    pub tier: ModelTier,
    pub enabled: bool,
    #[serde(default = "default_tools")]
    pub supports_tools: bool,
    pub supports_vision: bool,
    pub supports_reasoning: bool,
    pub context_window: u64,
    #[serde(default)]
    pub input_cost_per_million: f64,
    #[serde(default)]
    pub output_cost_per_million: f64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ModelTier {
    Fast,
    Balanced,
    Strong,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutingMode {
    Observe,
    Assist,
    Auto,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RoutingPolicy {
    pub mode: RoutingMode,
    pub prefer_local: bool,
    pub use_jev_when_ambiguous: bool,
    pub jev_endpoint: String,
    #[serde(default)]
    pub jev_model: String,
    #[serde(default)]
    pub decision_preference: String,
    #[serde(default)]
    pub has_autojev_key: bool,
    pub savings_baseline_model_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RouteEvent {
    pub id: String,
    pub created_at: String,
    pub endpoint: String,
    pub provider_name: String,
    pub model_name: String,
    pub reason: String,
    pub source: String,
    pub estimated_input_tokens: u64,
    pub estimated_cost: Option<f64>,
    pub estimated_savings: f64,
    pub success: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RouteRule {
    #[serde(default)]
    pub all_models: bool,
    #[serde(default)]
    pub automatic_policy: Option<RoutingPolicy>,
    #[serde(default)]
    pub model_settings: std::collections::HashMap<String, RouteModelSettings>,
    pub id: String,
    pub name: String,
    pub strategy: String,
    pub model_ids: Vec<String>,
    pub enabled: bool,
}

impl RouteRule {
    pub fn includes_model(&self, id: &str) -> bool {
        (self.strategy == "jev" && self.all_models) || self.model_ids.iter().any(|candidate| candidate == id)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(skip)]
    pub cost_history: Vec<crate::traffic::RequestLog>,
    #[serde(skip)]
    pub output_limit: Option<u64>,
    #[serde(skip)]
    pub cost_incumbent: Option<String>,
    #[serde(default)]
    pub performance_settings: crate::performance::Settings,
    #[serde(default)]
    pub performance_samples: std::collections::HashMap<String, Vec<crate::performance::Sample>>,
    #[serde(default)]
    pub gateway: crate::resilience::Settings,
    #[serde(default)]
    pub agent_catalogs: std::collections::HashMap<String, Vec<crate::agent_catalog::Entry>>,
    #[serde(default)]
    pub agent_selections: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub agent_auto_connect: std::collections::HashMap<String, bool>,
    #[serde(default)]
    pub custom_agents: Vec<crate::agents::CustomAgent>,
    #[serde(default)]
    pub routes: Vec<RouteRule>,
    pub install_id: String,
    pub port: u16,
    pub providers: Vec<Provider>,
    pub models: Vec<Model>,
    pub policy: RoutingPolicy,
    #[serde(default)]
    pub events: Vec<RouteEvent>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            cost_history: Vec::new(), output_limit: None, cost_incumbent: None,
            performance_settings: Default::default(),
            performance_samples: Default::default(),
            gateway: Default::default(),
            agent_catalogs: Default::default(),
            agent_selections: Default::default(),
            agent_auto_connect: Default::default(),
            custom_agents: Vec::new(),
            routes: Vec::new(),
            install_id: Uuid::new_v4().to_string(),
            port: DEFAULT_PORT,
            providers: vec![
                Provider {
                    preset: String::new(), api_type: String::new(), test_model: String::new(),
                    id: "openrouter".into(),
                    name: "OpenRouter".into(),
                    kind: ProviderKind::Openrouter,
                    base_url: "https://openrouter.ai/api".into(),
                    enabled: true,
                    has_api_key: false,
                },
                Provider {
                    preset: String::new(), api_type: String::new(), test_model: String::new(),
                    id: "ollama".into(),
                    name: "Ollama".into(),
                    kind: ProviderKind::Ollama,
                    base_url: "http://127.0.0.1:11434".into(),
                    enabled: false,
                    has_api_key: false,
                },
            ],
            models: vec![
                Model { input_price_known: None, output_price_known: None, cache_price_known: None,
                    api_type: String::new(), cache_cost_per_million: 0.0,
                    id: "qwen-fast".into(),
                    provider_id: "openrouter".into(),
                    model_id: "qwen/qwen3-coder-flash".into(),
                    name: "Qwen 3 Coder Flash".into(),
                    tier: ModelTier::Fast,
                    enabled: true,
                    supports_tools: true,
                    supports_vision: false,
                    supports_reasoning: false,
                    context_window: 262_144,
                    input_cost_per_million: 0.3,
                    output_cost_per_million: 1.2,
                },
                Model { input_price_known: None, output_price_known: None, cache_price_known: None,
                    api_type: String::new(), cache_cost_per_million: 0.0,
                    id: "claude-sonnet-4".into(),
                    provider_id: "openrouter".into(),
                    model_id: "anthropic/claude-sonnet-4".into(),
                    name: "Claude Sonnet 4".into(),
                    tier: ModelTier::Strong,
                    enabled: true,
                    supports_tools: true,
                    supports_vision: true,
                    supports_reasoning: true,
                    context_window: 200_000,
                    input_cost_per_million: 3.0,
                    output_cost_per_million: 15.0,
                },
            ],
            policy: RoutingPolicy {
                mode: RoutingMode::Auto,
                prefer_local: false,
                use_jev_when_ambiguous: true,
                jev_model: "~typesafe/jev-latest".into(),
                decision_preference: "balanced".into(),
                jev_endpoint: "https://openrouter.ai/api/alpha/decisions".into(),
                has_autojev_key: false,
                savings_baseline_model_id: Some("claude-sonnet-4".into()),
            },
            events: Vec::new(),
        }
    }
}

pub struct ConfigStore {
    path: PathBuf,
    value: RwLock<AppConfig>,
}

impl ConfigStore {
    pub fn load(path: PathBuf) -> Result<Self> { Self::load_with(path, AppConfig::default) }
    /// Opens the app database; a new install starts without placeholder providers or models.
    pub fn open(path: PathBuf) -> Result<Self> {
        Self::load_with(path, || {
            let mut value = AppConfig::default();
            value.providers.clear();
            value.models.clear();
            value.policy.savings_baseline_model_id = None;
            value
        })
    }
    fn load_with(path: PathBuf, seed: impl FnOnce() -> AppConfig) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).context("create AutoJev data directory")?;
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
            }
        }
        let mut db = Self::connect(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        }
        db.execute_batch("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials (account TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS request_logs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS request_logs_created ON request_logs(created_at);")?;
        let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let stored: Option<String> = transaction.query_row("SELECT value FROM app_meta WHERE key = 'config'", [], |row| row.get(0)).optional()?;
        let mut value: AppConfig = if let Some(data) = stored {
            serde_json::from_str(&data).context("parse AutoJev database configuration")?
        } else {
            let value = seed();
            transaction.execute("INSERT INTO app_meta (key, value) VALUES ('config', ?1)", [serde_json::to_string(&value)?])?;
            value
        };
        if value.performance_settings.version == 0 {
            value.performance_settings = Default::default();
            transaction.execute("UPDATE app_meta SET value = ?1 WHERE key = 'config'", [serde_json::to_string(&value)?])?;
        }
        if value.models.iter().any(|model| !model.supports_tools) {
            for model in &mut value.models { model.supports_tools = true; }
            transaction.execute("UPDATE app_meta SET value = ?1 WHERE key = 'config'", [serde_json::to_string(&value)?])?;
        }
        // Import previously retained route events once; their token usage remains unknown.
        for event in &value.events {
            let log = crate::traffic::RequestLog {
                id: event.id.clone(), created_at: event.created_at.clone(), agent: "Unknown agent".into(),
                endpoint: event.endpoint.clone(), provider_name: event.provider_name.clone(),
                model_name: event.model_name.clone(), source: event.source.clone(), reason: event.reason.clone(),
                status: if event.success { "success" } else { "error" }.into(),
                ..Default::default()
            };
            transaction.execute("INSERT OR IGNORE INTO request_logs (id, created_at, data) VALUES (?1, ?2, ?3)",
                rusqlite::params![log.id, log.created_at, serde_json::to_string(&log)?])?;
        }
        transaction.commit()?;
        Ok(Self { path, value: RwLock::new(value) })
    }

    fn connect(path: &PathBuf) -> Result<Connection> {
        let db = Connection::open(path).context("open AutoJev database")?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(db)
    }

    pub fn read(&self) -> AppConfig {
        self.value.read().expect("config lock poisoned").clone()
    }

    pub fn update<T>(&self, change: impl FnOnce(&mut AppConfig) -> T) -> Result<T> {
        let mut current = self.value.write().expect("config lock poisoned");
        let mut next = current.clone();
        let result = change(&mut next);
        let db = Self::connect(&self.path)?;
        db.execute("INSERT INTO app_meta (key, value) VALUES ('config', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [serde_json::to_string(&next)?])
            .context("save AutoJev configuration")?;
        *current = next;
        Ok(result)
    }

    pub fn update_checked(&self, change: impl FnOnce(&mut AppConfig) -> Result<()>, credential: Option<(&str, &str, Option<&str>)>) -> Result<()> {
        let mut current = self.value.write().expect("config lock poisoned");
        let mut next = current.clone();
        change(&mut next)?;
        let mut db = Self::connect(&self.path)?;
        let tx = db.transaction()?;
        if let Some((old, new, key)) = credential {
            if old != new {
                tx.execute("INSERT OR REPLACE INTO credentials (account,value) SELECT ?2,value FROM credentials WHERE account=?1", [old,new])?;
                tx.execute("DELETE FROM credentials WHERE account=?1", [old])?;
            }
            if let Some(key) = key {
                tx.execute("INSERT INTO credentials (account,value) VALUES (?1,?2) ON CONFLICT(account) DO UPDATE SET value=excluded.value", [new,key])?;
            }
        }
        tx.execute("INSERT INTO app_meta (key,value) VALUES ('config',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(&next)?])?;
        tx.commit()?;
        *current = next;
        Ok(())
    }

    pub fn save_request_log(&self, log: &crate::traffic::RequestLog) -> Result<()> {
        Self::connect(&self.path)?.execute("INSERT OR REPLACE INTO request_logs (id, created_at, data) VALUES (?1, ?2, ?3)",
            rusqlite::params![log.id, log.created_at, serde_json::to_string(log)?])?;
        Ok(())
    }

    pub fn request_log(&self, id: &str) -> Result<Option<crate::traffic::RequestLog>> {
        use rusqlite::OptionalExtension;
        let data: Option<String> = Self::connect(&self.path)?.query_row(
            "SELECT data FROM request_logs WHERE id = ?1", [id], |row| row.get(0),
        ).optional()?;
        data.map(|value| serde_json::from_str(&value).map_err(Into::into)).transpose()
    }

    pub fn request_logs(&self, since: &str) -> Result<Vec<crate::traffic::RequestLog>> {
        let db = Self::connect(&self.path)?;
        let mut statement = db.prepare("SELECT data FROM request_logs WHERE created_at >= ?1 ORDER BY created_at DESC, id DESC")?;
        let rows = statement.query_map([since], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn recent_cost_logs(&self) -> Result<Vec<crate::traffic::RequestLog>> {
        let db = Self::connect(&self.path)?;
        let since = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
        let mut statement = db.prepare("SELECT data FROM request_logs WHERE created_at >= ?1 ORDER BY created_at DESC LIMIT 500")?;
        let rows = statement.query_map([since], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn add_event(&self, event: RouteEvent) -> Result<()> {
        self.update(|config| {
            config.events.insert(0, event);
            config.events.truncate(250);
        })
    }
}

impl ConfigStore {
    pub fn read_secret(&self, account: &str) -> Option<String> {
        Self::connect(&self.path).ok()?.query_row(
            "SELECT value FROM credentials WHERE account = ?1", [account], |row| row.get::<_, String>(0)
        ).optional().ok().flatten().filter(|value| !value.is_empty())
    }

    pub fn write_secret(&self, account: &str, value: &str) -> Result<()> {
        Self::connect(&self.path)?.execute(
            "INSERT INTO credentials (account, value) VALUES (?1, ?2) ON CONFLICT(account) DO UPDATE SET value = excluded.value", [account, value]
        ).context("save local credential")?;
        Ok(())
    }

    pub fn delete_secret(&self, account: &str) -> Result<()> {
        Self::connect(&self.path)?.execute("DELETE FROM credentials WHERE account = ?1", [account]).context("delete local credential")?;
        Ok(())
    }
}

#[cfg(test)]
mod storage_tests {
    use super::*;

    #[test]
    fn initializes_database_and_persists_updates() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("autojev.db");
        let store = ConfigStore::load(db.clone()).unwrap();
        let install_id = store.read().install_id;
        store.update(|c| { c.port = 9999; c.providers.clear(); c.models.clear(); }).unwrap();
        drop(store);
        let reopened = ConfigStore::load(db).unwrap();
        assert_eq!(reopened.read().install_id, install_id);
        assert_eq!(reopened.read().port, 9999);
        assert!(reopened.read().providers.is_empty());
        assert!(reopened.read().models.is_empty());
    }

    #[test]
    fn failed_write_keeps_memory_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("autojev.db");
        let store = ConfigStore::load(db.clone()).unwrap();
        Connection::open(db).unwrap().execute_batch("DROP TABLE app_meta;").unwrap();
        let before = store.read().port;
        assert!(store.update(|c| c.port = 9999).is_err());
        assert_eq!(store.read().port, before);
    }
    #[test]
    fn checked_edit_moves_credentials_atomically_and_rolls_back_on_failure() {
        let dir=tempfile::tempdir().unwrap();
        let path=dir.path().join("autojev.db");
        let store=ConfigStore::load(path.clone()).unwrap();
        store.write_secret("provider:old","key").unwrap();
        let before=store.read().port;
        assert!(store.update_checked(|c| {c.port=1; anyhow::bail!("conflict")},Some(("provider:old","provider:new",None))).is_err());
        assert_eq!(store.read().port,before);
        assert_eq!(store.read_secret("provider:old").as_deref(),Some("key"));
        assert!(store.read_secret("provider:new").is_none());
        store.update_checked(|c| {c.port=9999;Ok(())},Some(("provider:old","provider:new",None))).unwrap();
        assert!(store.read_secret("provider:old").is_none());
        assert_eq!(store.read_secret("provider:new").as_deref(),Some("key"));
        Connection::open(&path).unwrap().execute_batch("DROP TABLE app_meta;").unwrap();
        assert!(store.update_checked(|c| {c.port=2;Ok(())},Some(("provider:new","provider:failed",Some("new-key")))).is_err());
        assert_eq!(store.read().port,9999);
        assert_eq!(store.read_secret("provider:new").as_deref(),Some("key"));
        assert!(store.read_secret("provider:failed").is_none());
    }

    #[test]
    fn credentials_persist_and_stay_out_of_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("autojev.db");
        let store = ConfigStore::load(path.clone()).unwrap();
        store.write_secret("provider:test", "fixture-key").unwrap();
        assert!(!serde_json::to_string(&store.read()).unwrap().contains("fixture-key"));
        drop(store);
        let store = ConfigStore::load(path).unwrap();
        assert_eq!(store.read_secret("provider:test").as_deref(), Some("fixture-key"));
        store.write_secret("provider:test", "replacement-key").unwrap();
        assert_eq!(store.read_secret("provider:test").as_deref(), Some("replacement-key"));
        let other = ConfigStore::load(dir.path().join("other.db")).unwrap();
        assert!(other.read_secret("provider:test").is_none());
        store.delete_secret("provider:test").unwrap();
        assert!(store.read_secret("provider:test").is_none());
    }

    #[test]
    fn model_protocol_and_cache_price_persist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models.db");
        let store = ConfigStore::load(path.clone()).unwrap();
        store.update(|config| {
            config.models[0].api_type = "messages".into();
            config.models[0].cache_cost_per_million = 0.025;
        }).unwrap();
        let model = ConfigStore::load(path).unwrap().read().models[0].clone();
        assert_eq!(model.api_type, "messages");
        assert_eq!(model.cache_cost_per_million, 0.025);
    }

}

#[cfg(test)]
mod request_log_tests {
    use super::*;
    #[test]
    fn request_lookup_is_exact_and_missing_metadata_stays_missing() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::load(dir.path().join("debug.db")).unwrap();
        for (id, reason) in [("request-a", "Jev choice"), ("request-b", "Session reuse")] {
            store.save_request_log(&crate::traffic::RequestLog {
                id: id.into(), reason: reason.into(), ..Default::default()
            }).unwrap();
        }
        assert_eq!(store.request_log("request-a").unwrap().unwrap().reason, "Jev choice");
        assert_eq!(store.request_log("request-b").unwrap().unwrap().reason, "Session reuse");
        assert!(store.request_log("missing").unwrap().is_none());
    }
    #[test]
    fn migrates_legacy_events_without_duplicates_or_invented_usage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let store = ConfigStore::load(path.clone()).unwrap();
        store.add_event(RouteEvent { id: "legacy".into(), created_at: "2026-09-20T00:00:00+00:00".into(),
            endpoint: "responses".into(), provider_name: "Provider".into(), model_name: "Model".into(),
            reason: "Legacy route".into(), source: "local".into(), estimated_input_tokens: 500,
            estimated_cost: Some(0.1), estimated_savings: 0., success: true }).unwrap();
        let reopened = ConfigStore::load(path.clone()).unwrap();
        let mut logs = reopened.request_logs("").unwrap();
        assert_eq!(logs.len(), 1); assert_eq!(logs[0].input_tokens, None);
        assert_eq!(logs[0].estimated_cost, None);
        logs[0].input_tokens = Some(42);
        reopened.save_request_log(&logs[0]).unwrap();
        let latest = ConfigStore::load(path).unwrap().request_logs("").unwrap();
        assert_eq!(latest.len(), 1); assert_eq!(latest[0].input_tokens, Some(42));
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RouteModelSettings { pub priority: u32, pub weight: u32 }
#[cfg(test)]
mod fresh_install_tests {
    #[test]
    fn new_install_has_no_placeholder_providers_and_existing_data_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("autojev.db");
        let fresh = super::ConfigStore::open(path.clone()).unwrap().read();
        assert!(fresh.providers.is_empty() && fresh.models.is_empty() && fresh.policy.savings_baseline_model_id.is_none());
        let seeded = dir.path().join("seeded.db");
        super::ConfigStore::load(seeded.clone()).unwrap();
        assert_eq!(super::ConfigStore::open(seeded).unwrap().read().providers.len(), 2);
    }
}
