//! Minimal blocking Yamcs HTTP client used by executor workers.
//!
//! Endpoints used:
//!   GET  /api/processors/{instance}/{processor}/parameters/{name}
//!   POST /api/processors/{instance}/{processor}/parameters:batchGet
//!   PUT  /api/processors/{instance}/{processor}/parameters/{name}
//!   POST /api/processors/{instance}/{processor}/commands/{name}
//!   GET  /api/archive/{instance}/commands/{id}
//!
//! Parameter values and command history also come from a WebSocket
//! subscription (`live`), with these endpoints as the fallback.
//!
//! With `--yamcs-token-file`, requests carry `Authorization: Bearer <file
//! contents>`; on 401 the file is read again (the plugin rewrites it before
//! the token expires) and the request is retried once.

pub mod live;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use reqwest::StatusCode;
use reqwest::blocking::{RequestBuilder, Response};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::worker::lang::worker_message;

#[derive(Debug, Clone, clap::Args)]
pub struct YamcsConfig {
    /// Yamcs base URL, e.g. http://localhost:8090
    #[arg(long = "yamcs", env = "FOPS_YAMCS_URL")]
    pub url: Option<String>,
    #[arg(long, default_value = "myproject", env = "FOPS_YAMCS_INSTANCE")]
    pub instance: String,
    #[arg(long, default_value = "realtime", env = "FOPS_YAMCS_PROCESSOR")]
    pub processor: String,
    /// File holding a Yamcs access token (sent as a Bearer token, re-read on 401).
    #[arg(long, env = "FOPS_YAMCS_TOKEN_FILE")]
    pub yamcs_token_file: Option<PathBuf>,
}

pub struct Yamcs {
    http: reqwest::blocking::Client,
    base: String,
    instance: String,
    processor: String,
    token_file: Option<PathBuf>,
    token: Mutex<Option<String>>,
    live: Arc<live::Live>,
}

#[derive(Clone)]
pub struct ParamValue {
    pub eng: Value,
    pub raw: Value,
    pub valid: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Ack {
    pub name: String,
    pub status: String,
    pub message: Option<String>,
}

pub fn qualify(name: &str) -> String {
    if name.starts_with('/') { name.to_string() } else { format!("/{name}") }
}

impl Yamcs {
    pub fn new(cfg: &YamcsConfig) -> Option<Self> {
        let url = cfg.url.as_ref()?;
        let live = live::Live::start(url, cfg);
        Some(Yamcs {
            http: reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).build().ok()?,
            base: url.trim_end_matches('/').to_string(),
            instance: cfg.instance.clone(),
            processor: cfg.processor.clone(),
            token_file: cfg.yamcs_token_file.clone(),
            token: Mutex::new(cfg.yamcs_token_file.as_ref().and_then(|f| read_token(f))),
            live,
        })
    }

    pub fn live(&self) -> &live::Live {
        &self.live
    }

    /// (base URL, instance, processor, token file)
    pub fn connection(&self) -> (&str, &str, &str, Option<&std::path::Path>) {
        (&self.base, &self.instance, &self.processor, self.token_file.as_deref())
    }

    /// Sends the request built by `req`, authenticated; on 401 reads the
    /// token file again and retries once.
    fn send(&self, req: impl Fn() -> RequestBuilder) -> reqwest::Result<Response> {
        let with_token = |r: RequestBuilder| match self.token.lock().as_deref() {
            Some(t) => r.bearer_auth(t),
            None => r,
        };
        let resp = with_token(req()).send()?;
        if resp.status() != StatusCode::UNAUTHORIZED {
            return Ok(resp);
        }
        let Some(f) = &self.token_file else { return Ok(resp) };
        *self.token.lock() = read_token(f);
        with_token(req()).send()
    }

    fn processor_url(&self) -> String {
        format!("{}/api/processors/{}/{}", self.base, self.instance, self.processor)
    }

    /// Latest values of several parameters at once, by qualified name.
    /// Parameters Yamcs has no value for are absent from the result.
    pub fn get_parameters(&self, names: &[String], wait: bool, timeout: Duration) -> Result<Vec<(String, ParamValue)>> {
        let url = format!("{}/parameters:batchGet", self.processor_url());
        let ids: Vec<Value> = names.iter().map(|n| json!({ "name": qualify(n) })).collect();
        let mut body = json!({ "id": ids, "fromCache": !wait });
        if wait {
            body["timeout"] = json!(timeout.as_millis() as u64);
        }
        let resp = self.send(|| self.http.post(&url).json(&body)).with_context(|| format!("POST {url}"))?;
        let status = resp.status();
        let body: Value = resp.json().unwrap_or(Value::Null);
        if !status.is_success() {
            bail!("HTTP {status}: {}", body["msg"].as_str().unwrap_or("batchGet failed"));
        }
        Ok(body["value"].as_array().into_iter().flatten().map(|v| (id_name(&v["id"]), param_value(v))).collect())
    }

    /// Sets a local parameter: `value` is a plain JSON value, sent as the
    /// Yamcs type of the parameter `kind` (the MDB engineering type).
    pub fn set_parameter(&self, name: &str, kind: &str, value: &Value) -> Result<()> {
        let url = format!("{}/parameters{}", self.processor_url(), qualify(name));
        let body = parameter_value(kind, value)?;
        let resp = self.send(|| self.http.put(&url).json(&body)).with_context(|| format!("PUT {url}"))?;
        let status = resp.status();
        if !status.is_success() {
            let body: Value = resp.json().unwrap_or(Value::Null);
            bail!("HTTP {status}: {}", body["msg"].as_str().unwrap_or("set refused"));
        }
        Ok(())
    }

    /// Returns the Yamcs command id. `options` are the extra command
    /// options (`cop1Bypass`...), by id: Yamcs rejects one it does not know.
    pub fn issue_command(&self, name: &str, args: &Value, options: &Value, comment: Option<&str>) -> Result<String> {
        let url = format!("{}/commands{}", self.processor_url(), qualify(name));
        let mut body = json!({ "args": args, "origin": live::ORIGIN });
        if let Some(c) = comment {
            body["comment"] = json!(c);
        }
        if let Some(o) = options.as_object().filter(|o| !o.is_empty()) {
            body["extra"] = o.iter().map(|(k, v)| Ok((k.clone(), option_value(v)?))).collect::<Result<_>>()?;
        }
        let resp = self.send(|| self.http.post(&url).json(&body)).with_context(|| format!("POST {url}"))?;
        let status = resp.status();
        let body: Value = resp.json().unwrap_or(Value::Null);
        if !status.is_success() {
            bail!("HTTP {status}: {}", body["msg"].as_str().unwrap_or("command rejected"));
        }
        body["id"].as_str().map(str::to_string).context("no command id in response")
    }

    /// Current acknowledgement attributes of a command, or None while Yamcs has
    /// not archived it yet.
    pub fn command_acks(&self, id: &str) -> Result<Option<Vec<Ack>>> {
        let url = format!("{}/api/archive/{}/commands/{}", self.base, self.instance, id);
        let resp = self.send(|| self.http.get(&url))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let body: Value = resp.error_for_status()?.json()?;
        Ok(Some(acks(&string_attrs(&body["attr"]))))
    }
}

/// The qualified name in a Yamcs `NamedObjectId`.
fn id_name(id: &Value) -> String {
    match id["namespace"].as_str() {
        Some(ns) if !ns.is_empty() => format!("{}/{}", ns.trim_end_matches('/'), id["name"].as_str().unwrap_or("")),
        _ => id["name"].as_str().unwrap_or("").to_string(),
    }
}

/// A Yamcs `ParameterValue` (JSON form).
fn param_value(v: &Value) -> ParamValue {
    ParamValue {
        eng: convert_value(&v["engValue"]),
        raw: convert_value(&v["rawValue"]),
        valid: v["acquisitionStatus"].as_str().is_none_or(|s| s == "ACQUIRED"),
    }
}

/// The string-valued attributes of a command history entry.
fn string_attrs(attr: &Value) -> Vec<(String, String)> {
    attr.as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| Some((a["name"].as_str()?.to_string(), a["value"]["stringValue"].as_str()?.to_string())))
        .collect()
}

/// The acknowledgements (`<name>_Status`, `<name>_Message`) in command attributes.
pub fn acks(attrs: &[(String, String)]) -> Vec<Ack> {
    let message = |stage: &str| {
        let key = format!("{stage}_Message");
        attrs.iter().find(|(n, _)| *n == key).map(|(_, v)| v.clone())
    };
    attrs
        .iter()
        .filter_map(|(n, s)| {
            let name = n.strip_suffix("_Status")?;
            Some(Ack { name: name.to_string(), status: s.clone(), message: message(name) })
        })
        .collect()
}

fn read_token(f: &std::path::Path) -> Option<String> {
    match std::fs::read_to_string(f) {
        Ok(t) if !t.trim().is_empty() => Some(t.trim().to_string()),
        Ok(_) => None,
        Err(e) => {
            worker_message(&format!("token file {}: {e}", f.display()));
            None
        }
    }
}

/// Converts a Yamcs `Value` message (JSON form) into a plain JSON value.
pub fn convert_value(v: &Value) -> Value {
    let Some(ty) = v["type"].as_str() else { return Value::Null };
    let field = match ty {
        "FLOAT" => "floatValue",
        "DOUBLE" => "doubleValue",
        "UINT32" => "uint32Value",
        "SINT32" => "sint32Value",
        "UINT64" => "uint64Value",
        "SINT64" => "sint64Value",
        "BOOLEAN" => "booleanValue",
        "STRING" | "ENUMERATED" => "stringValue",
        "TIMESTAMP" => "stringValue",
        "BINARY" => "binaryValue",
        _ => return v.clone(),
    };
    match &v[field] {
        // protobuf JSON encodes 64-bit integers as strings
        Value::String(s) if ty.ends_with("64") => s
            .parse::<i64>()
            .map(Value::from)
            .or_else(|_| s.parse::<u64>().map(Value::from))
            .unwrap_or(Value::String(s.clone())),
        Value::Null if ty == "BOOLEAN" => Value::Bool(false),
        Value::Null => json!(0),
        x => x.clone(),
    }
}

/// A command option value as a Yamcs `Value`; Yamcs coerces it to the
/// option's type (a timestamp is given as an RFC 3339 string). Integers go
/// as SINT32, like the Yamcs web interface sends them: Yamcs cannot store a
/// SINT64 option in the command history.
fn option_value(v: &Value) -> Result<Value> {
    Ok(match v {
        Value::Bool(b) => json!({ "type": "BOOLEAN", "booleanValue": b }),
        Value::Number(n) if n.as_i64().is_some_and(|i| i32::try_from(i).is_ok()) => {
            json!({ "type": "SINT32", "sint32Value": n.as_i64() })
        }
        Value::Number(n) => json!({ "type": "DOUBLE", "doubleValue": n.as_f64() }),
        Value::String(s) => json!({ "type": "STRING", "stringValue": s }),
        _ => bail!("command option value {v}: a bool, number or string is needed"),
    })
}

/// A parameter value as a Yamcs `Value` of the type of an MDB engineering
/// type (`kind`); Yamcs converts it to the parameter's own type.
fn parameter_value(kind: &str, v: &Value) -> Result<Value> {
    Ok(match (kind, v) {
        ("boolean", Value::Bool(b)) => json!({ "type": "BOOLEAN", "booleanValue": b }),
        ("integer", Value::Number(n)) if n.is_i64() => json!({ "type": "SINT64", "sint64Value": n.as_i64() }),
        ("integer", Value::Number(n)) if n.is_u64() => json!({ "type": "UINT64", "uint64Value": n.as_u64() }),
        ("integer", Value::Number(n)) if n.as_f64().is_some_and(|f| f.fract() == 0.0) => {
            json!({ "type": "SINT64", "sint64Value": n.as_f64().unwrap() as i64 })
        }
        ("float", Value::Number(n)) => json!({ "type": "DOUBLE", "doubleValue": n.as_f64() }),
        ("string" | "enumeration", Value::String(s)) => json!({ "type": "STRING", "stringValue": s }),
        ("time", Value::String(s)) => json!({ "type": "TIMESTAMP", "stringValue": s }),
        _ => bail!("cannot set a {kind} parameter to {v}"),
    })
}
