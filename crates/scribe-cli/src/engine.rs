use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
};

use serde::{Serialize, de::DeserializeOwned};

use crate::protocol::{
    EngineEvent, Incoming, InitializeParams, InitializeResult, MAX_MESSAGE_BYTES, PROTOCOL_VERSION,
    Request, Response,
};

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("Scribe's engine entry is missing at {0}.")]
    Missing(PathBuf),
    #[error("Could not start Scribe's engine: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("Could not communicate with Scribe's engine: {0}")]
    Io(#[source] std::io::Error),
    #[error("Scribe's engine emitted malformed protocol data: {0}")]
    Protocol(String),
    #[error("Scribe's engine stopped before completing the request.")]
    Closed,
    #[error("Scribe's engine rejected the operation: {message}")]
    Remote {
        code: i32,
        message: String,
        kind: Option<String>,
        recovery: Vec<String>,
        partial_state: bool,
    },
    #[error("Scribe's native CLI ({cli}) and engine ({engine}) versions differ.")]
    VersionMismatch { cli: String, engine: String },
    #[error(
        "Scribe's native CLI and engine use incompatible protocol versions ({cli} and {engine})."
    )]
    ProtocolMismatch { cli: u16, engine: u16 },
    #[error("{0}")]
    Usage(String),
}
pub struct EngineClient {
    child: Child,
    stdin: ChildStdin,
    incoming: Receiver<Result<Incoming, EngineError>>,
    next_id: u64,
}

impl EngineClient {
    pub fn spawn(
        engine_entry: &Path,
        cwd: &Path,
        cli_version: &str,
        invoked_binary: &str,
    ) -> Result<Self, EngineError> {
        if !engine_entry.is_file() {
            return Err(EngineError::Missing(engine_entry.to_path_buf()));
        }
        let mut child = Command::new(engine_executable())
            .arg(engine_entry)
            .arg("--engine")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(EngineError::Spawn)?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| EngineError::Protocol("engine stdin was not available".to_owned()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| EngineError::Protocol("engine stdout was not available".to_owned()))?;
        let incoming = spawn_reader(stdout);
        let mut client = Self {
            child,
            stdin,
            incoming,
            next_id: 1,
        };
        let initialized: InitializeResult = client.request(
            "initialize",
            InitializeParams {
                protocol_version: PROTOCOL_VERSION,
                cli_version,
                cwd,
                invoked_binary,
            },
            |_| {},
        )?;
        if initialized.protocol_version != PROTOCOL_VERSION {
            return Err(EngineError::ProtocolMismatch {
                cli: PROTOCOL_VERSION,
                engine: initialized.protocol_version,
            });
        }
        if initialized.engine_version != cli_version {
            return Err(EngineError::VersionMismatch {
                cli: cli_version.to_owned(),
                engine: initialized.engine_version,
            });
        }
        if !initialized
            .capabilities
            .iter()
            .any(|capability| capability == "validate")
        {
            return Err(EngineError::Protocol(
                "engine does not advertise the required validate capability".to_owned(),
            ));
        }
        Ok(client)
    }

    pub fn request<P, R>(
        &mut self,
        method: &str,
        params: P,
        mut on_event: impl FnMut(EngineEvent),
    ) -> Result<R, EngineError>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        let id = self.next_id;
        self.next_id += 1;
        let request = Request::new(id, method, params);
        serde_json::to_writer(&mut self.stdin, &request)
            .map_err(|error| EngineError::Protocol(error.to_string()))?;
        self.stdin.write_all(b"\n").map_err(EngineError::Io)?;
        self.stdin.flush().map_err(EngineError::Io)?;

        loop {
            match self.incoming.recv().map_err(|_| EngineError::Closed)?? {
                Incoming::Event(event) => {
                    validate_jsonrpc(&event.jsonrpc)?;
                    if event.method == "scribe/event" {
                        if event.params.operation_id.is_empty() {
                            return Err(EngineError::Protocol(
                                "engine event operationId must not be empty".to_owned(),
                            ));
                        }
                        on_event(event.params);
                    }
                }
                Incoming::Response(response) if response.id == id => {
                    return decode_response(response);
                }
                Incoming::Response(_) => {}
            }
        }
    }
}

impl Drop for EngineClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn engine_executable() -> String {
    std::env::var("SCRIBE_NODE_EXECUTABLE").unwrap_or_else(|_| "node".to_owned())
}

fn spawn_reader(stdout: ChildStdout) -> Receiver<Result<Incoming, EngineError>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || read_messages(stdout, |message| sender.send(message).is_ok()));
    receiver
}

fn read_messages(reader: impl Read, mut send: impl FnMut(Result<Incoming, EngineError>) -> bool) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader
            .by_ref()
            .take((MAX_MESSAGE_BYTES + 2) as u64)
            .read_until(b'\n', &mut line)
        {
            Ok(0) => return,
            Ok(_) if line.len() > MAX_MESSAGE_BYTES => {
                let _ = send(Err(EngineError::Protocol(format!(
                    "message exceeds {MAX_MESSAGE_BYTES} bytes"
                ))));
                return;
            }
            Ok(_) => {
                let parsed = serde_json::from_slice::<Incoming>(&line)
                    .map_err(|error| EngineError::Protocol(error.to_string()));
                if !send(parsed) {
                    return;
                }
            }
            Err(error) => {
                let _ = send(Err(EngineError::Io(error)));
                return;
            }
        }
    }
}

fn validate_jsonrpc(value: &str) -> Result<(), EngineError> {
    if value == "2.0" {
        Ok(())
    } else {
        Err(EngineError::Protocol(format!(
            "unsupported JSON-RPC version {value}"
        )))
    }
}

fn decode_response<R: DeserializeOwned>(response: Response) -> Result<R, EngineError> {
    validate_jsonrpc(&response.jsonrpc)?;
    match (response.result, response.error) {
        (Some(result), None) => {
            serde_json::from_value(result).map_err(|error| EngineError::Protocol(error.to_string()))
        }
        (None, Some(error)) => {
            let data = error.data;
            Err(EngineError::Remote {
                code: error.code,
                message: error.message,
                kind: data.as_ref().map(|value| value.kind.clone()),
                recovery: data
                    .as_ref()
                    .map_or_else(Vec::new, |value| value.recovery.clone()),
                partial_state: data.is_some_and(|value| value.partial_state),
            })
        }
        _ => Err(EngineError::Protocol(
            "response must contain exactly one of result or error".to_owned(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_lines() {
        let payload = vec![b'x'; MAX_MESSAGE_BYTES + 1];
        let (sender, receiver) = mpsc::channel();
        read_messages(payload.as_slice(), |message| sender.send(message).is_ok());
        let error = receiver
            .recv()
            .expect("message")
            .expect_err("oversized input must fail");
        assert!(error.to_string().contains("exceeds"));
    }

    #[test]
    fn rejects_result_and_error_together() {
        let response: Response = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-1,"message":"bad"}}"#,
        )
        .expect("fixture should parse");
        let error = decode_response::<serde_json::Value>(response)
            .expect_err("ambiguous response must fail");
        assert!(error.to_string().contains("exactly one"));
    }
}
