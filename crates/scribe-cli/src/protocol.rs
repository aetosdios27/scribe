use std::{collections::BTreeMap, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request<'a, T: Serialize> {
    pub jsonrpc: &'static str,
    pub id: u64,
    pub method: &'a str,
    pub params: T,
}

impl<'a, T: Serialize> Request<'a, T> {
    pub const fn new(id: u64, method: &'a str, params: T) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            method,
            params,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Incoming {
    Response(Response),
    Event(EventNotification),
}

#[derive(Debug, Deserialize)]
pub struct Response {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<RpcError>,
}

#[derive(Debug, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default)]
    pub data: Option<FailureData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureData {
    pub kind: String,
    #[serde(default)]
    pub recovery: Vec<String>,
    #[serde(default)]
    pub partial_state: bool,
}

#[derive(Debug, Deserialize)]
pub struct EventNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: EngineEvent,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineEvent {
    pub operation_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub stream: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams<'a> {
    pub protocol_version: u16,
    pub cli_version: &'a str,
    pub cwd: &'a Path,
    pub invoked_binary: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: u16,
    pub engine_version: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEnvelope {
    pub plan_id: String,
    pub summary: PlanSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub root: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub packages: Vec<PackagePlan>,
    #[serde(default)]
    pub commands: Vec<CommandPlan>,
    #[serde(default)]
    pub files: Vec<FilePlan>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub manual_steps: Vec<String>,
    #[serde(default)]
    pub values: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePlan {
    pub name: String,
    #[serde(default)]
    pub current: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub placement: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandPlan {
    pub label: String,
    pub command: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePlan {
    pub path: String,
    pub action: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub values: BTreeMap<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_additive_response_fields() {
        let incoming: Incoming = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":4,"result":{"planId":"abc","summary":{"root":"/tmp","files":[],"future":true}},"future":"ignored"}"#,
        )
        .expect("response should parse");
        let Incoming::Response(response) = incoming else {
            panic!("expected response");
        };
        assert_eq!(response.id, 4);
        assert!(response.result.is_some());
    }

    #[test]
    fn parses_shared_semantic_events() {
        let events: Vec<EventNotification> =
            serde_json::from_str(include_str!("../../../tests/fixtures/protocol/events.json"))
                .expect("shared events should parse");
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].params.operation_id, "update-1");
        assert_eq!(events[1].params.stream.as_deref(), Some("stderr"));
        assert_eq!(events[2].params.kind, "task.completed");
    }

    #[test]
    fn parses_shared_structured_failures() {
        let failures: Vec<Response> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/protocol/failures.json"
        ))
        .expect("shared failures should parse");
        let first = failures[0].error.as_ref().expect("first error");
        assert_eq!(first.code, -32_602);
        assert_eq!(first.data.as_ref().expect("failure data").kind, "path");
        assert!(
            failures[1]
                .error
                .as_ref()
                .and_then(|error| error.data.as_ref())
                .is_some_and(|data| data.partial_state)
        );
    }
}
