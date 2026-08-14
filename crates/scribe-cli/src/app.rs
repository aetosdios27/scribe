use std::{env, io, path::PathBuf, process::ExitCode};

use clap::Parser;
use serde::Serialize;
use serde_json::json;

use crate::{
    VERSION,
    cli::{Cli, Command, StudioCommand, StudioInitArgs},
    engine::{EngineClient, EngineError},
    protocol::{OperationResult, PlanEnvelope},
    terminal::{Capabilities, Presenter, prompt_confirm, prompt_text, render_inline_screen},
};

pub fn run() -> ExitCode {
    match run_inner() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            let capabilities = Capabilities::detect();
            let mut presenter = Presenter::new(io::stderr(), capabilities);
            let recovery = recovery(&error);
            let _ = presenter.failure(&error.to_string(), &recovery);
            ExitCode::from(exit_code(&error))
        }
    }
}

fn run_inner() -> Result<u8, EngineError> {
    let cli = Cli::parse();
    let cwd = env::current_dir().map_err(EngineError::Io)?;
    let engine_entry = engine_entry()?;
    let invoked_binary = env::args().next().unwrap_or_else(|| "scribe".to_owned());
    let mut engine = EngineClient::spawn(&engine_entry, &cwd, VERSION, &invoked_binary)?;
    let capabilities = Capabilities::detect();
    let mut presenter = Presenter::new(io::stdout(), capabilities);
    let Some(command) = cli.command else {
        return show_status(&mut engine, &mut presenter);
    };

    match command {
        Command::Validate(arguments) => {
            let result: OperationResult = engine.request("validate", arguments, |event| {
                let _ = presenter.event(&event);
            })?;
            presenter.receipt(true, &result).map_err(EngineError::Io)?;
        }
        Command::Studio(arguments) => match arguments.command {
            Some(StudioCommand::Init(arguments)) => {
                run_studio_init(&mut engine, &mut presenter, capabilities, &arguments)?;
            }
            None => {
                let Some(article) = arguments.article else {
                    return Err(EngineError::Usage(
                        "scribe studio requires an article path, or run `scribe studio init`."
                            .to_owned(),
                    ));
                };
                let params = json!({
                    "article": article,
                    "mode": arguments.mode,
                    "hostCss": arguments.host_css,
                    "port": arguments.port,
                    "noOpen": arguments.no_open,
                });
                let result: OperationResult = engine.request("studio.start", params, |event| {
                    let _ = presenter.event(&event);
                })?;
                presenter.receipt(true, &result).map_err(EngineError::Io)?;
            }
        },
        Command::Init(arguments) => {
            let dry_run = arguments.dry_run;
            let yes = arguments.yes;
            plan_and_apply(
                &mut engine,
                &mut presenter,
                "init.plan",
                "init.apply",
                arguments,
                !dry_run,
                yes,
            )?;
        }
        Command::Integrate(arguments) => {
            let dry_run = arguments.dry_run;
            let yes = arguments.yes;
            plan_and_apply(
                &mut engine,
                &mut presenter,
                "integrate.plan",
                "integrate.apply",
                arguments,
                !dry_run,
                yes,
            )?;
        }
        Command::Import(arguments) => {
            let dry_run = arguments.dry_run;
            let yes = arguments.yes;
            plan_and_apply(
                &mut engine,
                &mut presenter,
                "medium.plan",
                "medium.apply",
                arguments,
                !dry_run,
                yes,
            )?;
        }
        Command::Update(arguments) => {
            let dry_run = arguments.dry_run;
            let yes = arguments.yes;
            plan_and_apply(
                &mut engine,
                &mut presenter,
                "update.plan",
                "update.apply",
                arguments,
                !dry_run,
                yes,
            )?;
        }
    }
    Ok(0)
}

fn show_status(
    engine: &mut EngineClient,
    presenter: &mut Presenter<impl io::Write>,
) -> Result<u8, EngineError> {
    let result: OperationResult = engine.request("status", json!({}), |event| {
        let _ = presenter.event(&event);
    })?;
    if presenter.capabilities().interactive {
        let rows = result
            .values
            .iter()
            .map(|(label, value)| {
                (
                    label.clone(),
                    value
                        .as_str()
                        .map_or_else(|| value.to_string(), str::to_owned),
                )
            })
            .collect::<Vec<_>>();
        let borrowed = rows
            .iter()
            .map(|(label, value)| (label.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        render_inline_screen(
            result.title.as_deref().unwrap_or("Project status"),
            result.message.as_deref().unwrap_or(""),
            &borrowed,
        )
        .map_err(EngineError::Io)?;
    } else {
        presenter.receipt(true, &result).map_err(EngineError::Io)?;
    }
    Ok(0)
}

fn run_studio_init(
    engine: &mut EngineClient,
    presenter: &mut Presenter<impl io::Write>,
    capabilities: Capabilities,
    arguments: &StudioInitArgs,
) -> Result<(), EngineError> {
    let title = match arguments.title.clone() {
        Some(title) => title,
        None if !capabilities.interactive => {
            return Err(EngineError::Usage(
                "Article title is required in a non-interactive terminal. Pass --title and --yes."
                    .to_owned(),
            ));
        }
        None => {
            let Some(title) = prompt_text("Article title", None).map_err(EngineError::Io)? else {
                presenter
                    .cancelled("No article was created.")
                    .map_err(EngineError::Io)?;
                return Ok(());
            };
            title
        }
    };

    let defaults: OperationResult = engine.request(
        "studioArticle.suggest",
        json!({
            "title": title,
            "contentDirectory": arguments.content_dir,
            "path": arguments.path,
        }),
        |_| {},
    )?;
    let derived_slug = result_string(&defaults, "slug")?;
    let mut default_path = result_string(&defaults, "targetPath")?;

    let (slug, recalculate_path) = match arguments.slug.clone() {
        Some(slug) => {
            let changed = slug != derived_slug;
            (slug, changed)
        }
        None if arguments.yes => (derived_slug, false),
        None if !capabilities.interactive => {
            return Err(EngineError::Usage(
                "Re-run with --yes to accept the derived slug and article path.".to_owned(),
            ));
        }
        None => {
            let Some(slug) = prompt_text("Slug", Some(&derived_slug)).map_err(EngineError::Io)?
            else {
                presenter
                    .cancelled("No article was created.")
                    .map_err(EngineError::Io)?;
                return Ok(());
            };
            let changed = slug != derived_slug;
            (slug, changed)
        }
    };
    if arguments.path.is_none() && recalculate_path {
        default_path =
            suggested_article_path(engine, &title, &slug, arguments.content_dir.as_ref())?;
    }

    let path = match arguments.path.clone() {
        Some(path) => path,
        None if arguments.yes => PathBuf::from(default_path),
        None if !capabilities.interactive => {
            return Err(EngineError::Usage(
                "Re-run with --yes to accept the derived slug and article path.".to_owned(),
            ));
        }
        None => {
            let Some(path) =
                prompt_text("Article path", Some(&default_path)).map_err(EngineError::Io)?
            else {
                presenter
                    .cancelled("No article was created.")
                    .map_err(EngineError::Io)?;
                return Ok(());
            };
            PathBuf::from(path)
        }
    };

    let params = json!({
        "options": {
            "title": title,
            "slug": slug,
            "path": path,
            "contentDirectory": arguments.content_dir,
            "mode": arguments.mode,
            "hostCss": arguments.host_css,
            "port": arguments.port,
            "noOpen": arguments.no_open,
        },
        "interactive": capabilities.interactive,
    });
    plan_and_apply(
        engine,
        presenter,
        "studioArticle.plan",
        "studioArticle.apply",
        params,
        true,
        arguments.yes,
    )
}
fn suggested_article_path(
    engine: &mut EngineClient,
    title: &str,
    slug: &str,
    content_directory: Option<&PathBuf>,
) -> Result<String, EngineError> {
    let revised: OperationResult = engine.request(
        "studioArticle.suggest",
        json!({
            "title": title,
            "slug": slug,
            "contentDirectory": content_directory,
        }),
        |_| {},
    )?;
    result_string(&revised, "targetPath")
}

fn result_string(result: &OperationResult, key: &str) -> Result<String, EngineError> {
    result
        .values
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            EngineError::Protocol(format!(
                "engine response omitted required string value {key}"
            ))
        })
}

fn plan_and_apply<P: Serialize>(
    engine: &mut EngineClient,
    presenter: &mut Presenter<impl io::Write>,
    plan_method: &str,
    apply_method: &str,
    params: P,
    apply: bool,
    yes: bool,
) -> Result<(), EngineError> {
    let plan: PlanEnvelope = engine.request(plan_method, params, |event| {
        let _ = presenter.event(&event);
    })?;
    presenter
        .plan(plan_title(plan_method), &plan.summary)
        .map_err(EngineError::Io)?;
    if !apply {
        return Ok(());
    }
    if !yes {
        if !presenter.capabilities().interactive {
            return Err(EngineError::Usage(
                "The terminal is non-interactive. Re-run with --yes after reviewing the plan."
                    .to_owned(),
            ));
        }
        if prompt_confirm("Apply this Scribe plan?", false).map_err(EngineError::Io)? != Some(true)
        {
            presenter
                .cancelled("Cancelled. No changes made.")
                .map_err(EngineError::Io)?;
            return Ok(());
        }
    }
    let result: OperationResult =
        engine.request(apply_method, json!({ "planId": plan.plan_id }), |event| {
            let _ = presenter.event(&event);
        })?;
    presenter.receipt(true, &result).map_err(EngineError::Io)
}

fn plan_title(method: &str) -> &'static str {
    match method {
        "init.plan" => "Scribe Init",
        "integrate.plan" => "Scribe Integration",
        "medium.plan" => "Scribe Import",
        "studioArticle.plan" => "New Scribe Article",
        "update.plan" => "Scribe Update",
        _ => "Scribe Plan",
    }
}

fn engine_entry() -> Result<PathBuf, EngineError> {
    if let Some(entry) = env::var_os("SCRIBE_ENGINE_ENTRY") {
        return Ok(PathBuf::from(entry));
    }
    let executable = env::current_exe().map_err(EngineError::Io)?;
    let candidates = [
        executable.parent().map(|path| path.join("engine.mjs")),
        executable
            .parent()
            .and_then(|path| path.parent())
            .map(|path| path.join("dist/engine.mjs")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
        .ok_or_else(|| EngineError::Missing(PathBuf::from("dist/engine.mjs")))
}

fn recovery(error: &EngineError) -> Vec<String> {
    match error {
        EngineError::Missing(_) => vec!["Reinstall @scribe-sdk/cli for this platform.".to_owned()],
        EngineError::VersionMismatch { .. } => {
            vec!["Install matching Scribe package versions.".to_owned()]
        }
        EngineError::ProtocolMismatch { .. } => {
            vec!["Update the complete Scribe installation together.".to_owned()]
        }
        EngineError::Remote {
            recovery,
            partial_state,
            ..
        } => {
            let mut steps = recovery.clone();
            if *partial_state {
                steps.insert(
                    0,
                    "Review the reported partial filesystem state before retrying.".to_owned(),
                );
            }
            steps
        }
        EngineError::Usage(_) => Vec::new(),
        _ => {
            vec!["Retry the command; reinstall @scribe-sdk/cli if the failure persists.".to_owned()]
        }
    }
}

fn exit_code(error: &EngineError) -> u8 {
    match error {
        EngineError::Usage(_) | EngineError::Remote { code: -32_602, .. } => 2,
        EngineError::Remote {
            kind: Some(kind), ..
        } if is_usage_kind(kind) => 2,
        _ => 1,
    }
}

fn is_usage_kind(kind: &str) -> bool {
    matches!(kind, "usage" | "path" | "unsupported")
}
